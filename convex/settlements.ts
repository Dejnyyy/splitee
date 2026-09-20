import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUser, requireMembership } from "./guards";
import { memberLookup } from "./members";
import { aggregateDebts } from "./lib/debts";
import { ERROR } from "../lib/errors";
import { UNKNOWN_MEMBER_COLOR } from "../lib/colors";

/**
 * „Kdo komu kolik dluží" — vždy z konkrétních nevyrovnaných podílů (nikdy z
 * abstraktní bilance), aby šlo u každé karty dohledat, za co se dluží.
 * `by_group_settled` nemá filtr na datum: podíl z výdaje mimo aktuální
 * období pořád zakládá reálný dluh, dluh nevyprší tím, že se přehoupne měsíc.
 * `fromColor`/`toColor` jsou klíče z lib/colors.ts (`membership.color`), ne
 * hexy — zobrazovací vrstva si přes ně hex dohledá přes `colorByKey()`.
 * Chybějící člen (dnes nedosažitelné, appka nemá odchod z party) dostane
 * `UNKNOWN_MEMBER_COLOR`, ne barvu skutečného člena — ta je identita, ne
 * dekorace, a `colorByKey()` na ní schválně spadne, aby si ji zobrazovací
 * vrstva musela ošetřit zvlášť.
 * `splitIds` nese id všech nevyrovnaných podílů mezi dvojicí `from`/`to`
 * (v obou směrech, přesně to, co `aggregateDebts` sečetlo do `amount`) —
 * bez nich by tahle karta nebyla dohledatelná ke konkrétním výdajům a Task
 * 10 by pro vyrovnání jednotlivého podílu musela sahat znovu do
 * period-filtrovaného `expenses.listForGroup`, kde by starší dluh vůbec
 * nemusel být vidět.
 */
export const debts = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requireMembership(ctx, groupId);

    const unsettled = await ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", false))
      .collect();

    const members = await memberLookup(ctx, groupId);

    // Id podílů podle neuspořádané dvojice lidí — `aggregateDebts` netuje
    // oba směry do jednoho řádku, takže i tahle mapa musí sdružovat oba
    // směry pod stejný klíč, jinak by `splitIds` u výsledné karty pokrylo
    // jen polovinu toho, co `amount` ve skutečnosti sečetlo.
    const splitIdsByPair = new Map<string, Id<"splits">[]>();
    for (const s of unsettled) {
      const debtor = s.userId as string;
      const creditor = s.payerId as string;
      if (debtor === creditor) continue; // plátcův vlastní podíl nikdy není settled: false, ale pro jistotu
      const key = [debtor, creditor].sort().join("|");
      const list = splitIdsByPair.get(key);
      if (list) list.push(s._id);
      else splitIdsByPair.set(key, [s._id]);
    }

    return aggregateDebts(
      unsettled.map((s) => ({
        debtorId: s.userId as string,
        creditorId: s.payerId as string,
        amount: s.amount,
      })),
    ).map((debt) => ({
      from: debt.from as Id<"users">,
      to: debt.to as Id<"users">,
      amount: debt.amount,
      splitIds: splitIdsByPair.get([debt.from, debt.to].sort().join("|")) ?? [],
      fromNickname: members.get(debt.from)?.nickname ?? "Někdo",
      fromColor: members.get(debt.from)?.color ?? UNKNOWN_MEMBER_COLOR,
      toNickname: members.get(debt.to)?.nickname ?? "Někdo",
      toColor: members.get(debt.to)?.color ?? UNKNOWN_MEMBER_COLOR,
    }));
  },
});

/**
 * Označí jeden podíl za vyrovnaný — obyčejný „zaplaceno" checkbox u
 * konkrétní položky. Nenastavuje `settlementId` (ten patří jen hromadnému
 * `settleAllWith` s nenulovým rozdílem) — přesně tahle cesta je jeden ze
 * dvou důvodů, proč `deleteSplits` v convex/expenses.ts zamyká na
 * `settled && userId !== payerId`, ne jen na `settlementId`.
 *
 * Oprávnění: jen dlužník (`split.userId`) nebo věřitel (`split.payerId`) —
 * kdokoli jiný z party je jen přihlížející, kterého se ten konkrétní dluh
 * netýká.
 */
export const settleSplit = mutation({
  args: { splitId: v.id("splits") },
  handler: async (ctx, { splitId }) => {
    // requireUser dřív než čtení podílu — jinak by SPLIT_NOT_FOUND (na
    // neexistujícím id) vs. DEBT_NOT_YOURS/úspěch (na reálném) fungovalo
    // jako oracle na existenci id i bez přihlášení (stejný důvod jako u
    // expenses.update, convex/expenses.ts:236).
    const userId = await requireUser(ctx);
    const split = await ctx.db.get(splitId);
    if (split === null) throw new ConvexError({ code: ERROR.SPLIT_NOT_FOUND });
    await requireMembership(ctx, split.groupId);

    if (userId !== split.userId && userId !== split.payerId) {
      throw new ConvexError({ code: ERROR.DEBT_NOT_YOURS });
    }
    if (split.settled) return null; // idempotentní — dvojklik nebo souběžné volání není chyba

    await ctx.db.patch(splitId, { settled: true, settledAt: Date.now() });
    return null;
  },
});

/**
 * Vrátí jeden podíl zpátky mezi nevyrovnané — zrcadlí `settleSplit`, aby Task
 * 6's zámek ("nejdřív zruš vyrovnání") měl co udělat. Stejné oprávnění jako
 * settleSplit (dlužník nebo věřitel), plus dvě pojistky mimo settleSplit:
 *
 *  - plátcův vlastní podíl (`userId === payerId`) je vždy `settled: true` od
 *    založení výdaje a nepředstavuje dluh (viz convex/expenses.ts) — zrušení
 *    vyrovnání by ho nesmyslně vrátilo mezi "dlužné", proto PAYER_SPLIT_NOT_A_DEBT;
 *  - podíl se `settlementId` patří do hromadného vyrovnání (`settleAllWith`
 *    s nenulovým rozdílem) — zrušit ho jednotlivě by nechalo `settlements`
 *    řádek nesedět na to, co je/není vyrovnané. Takový podíl se ruší jen
 *    celý, přes `unsettleSettlement`.
 *
 * Podíl vyrovnaný přes `settleAllWith` s NULOVÝM rozdílem `settlementId`
 * nemá (viz komentář u `settleAllWith`) — ten se tady chová stejně jako
 * kterýkoli jiný osamocený `settleSplit` a jde vrátit zpátky bez omezení.
 */
export const unsettleSplit = mutation({
  args: { splitId: v.id("splits") },
  handler: async (ctx, { splitId }) => {
    // requireUser dřív než čtení podílu — stejný důvod jako u settleSplit výš.
    const userId = await requireUser(ctx);
    const split = await ctx.db.get(splitId);
    if (split === null) throw new ConvexError({ code: ERROR.SPLIT_NOT_FOUND });
    await requireMembership(ctx, split.groupId);

    if (userId !== split.userId && userId !== split.payerId) {
      throw new ConvexError({ code: ERROR.DEBT_NOT_YOURS });
    }
    if (split.userId === split.payerId) {
      throw new ConvexError({ code: ERROR.PAYER_SPLIT_NOT_A_DEBT });
    }
    if (split.settlementId !== undefined) {
      throw new ConvexError({ code: ERROR.SPLIT_PART_OF_SETTLEMENT });
    }
    if (!split.settled) return null; // idempotentní — nic k vrácení

    await ctx.db.patch(splitId, { settled: false, settledAt: undefined });
    return null;
  },
});

/**
 * Vyrovná všechny podíly mezi mnou (volajícím) a `otherUserId` naráz. Čistý
 * rozdíl počítá `aggregateDebts` (stejné jádro jako `debts` výše) — ne ruční
 * součet, aby netting logika žila na jednom místě.
 *
 *  - Žádný podíl mezi dvojicí → není co dělat, vrátí `null`.
 *  - Rozdíl přesně nula (oba dluží stejně) → všechny podíly se označí za
 *    vyrovnané, ale `settlements` řádek nevzniká (nic reálně nepřešlo z
 *    ruky do ruky) — přesně tenhle případ dokumentuje komentář u
 *    `deleteSplits` v convex/expenses.ts. Takové podíly nenesou
 *    `settlementId` (nemají co), takže se dají zvlášť vrátit přes
 *    `unsettleSplit` — jen ne naráz jedním voláním, protože spolu nesdílí
 *    žádný společný záznam.
 *  - Nenulový rozdíl → jeden `settlements` řádek s čistou částkou a směrem,
 *    všechny zahrnuté podíly dostanou jeho `settlementId`.
 *
 * Oprávnění: volající smí vyrovnávat jen svoje vlastní dluhy vůči
 * `otherUserId` — `userId` je vždy identita volajícího z `requireMembership`,
 * nejde vyrovnat dluhy mezi dvěma jinými lidmi za ně. Funguje shodně bez
 * ohledu na to, jestli volající je v páru dlužník nebo věřitel — směr
 * výsledného `settlements` řádku určuje jen `aggregateDebts`, ne to, kdo
 * mutaci zavolal.
 */
export const settleAllWith = mutation({
  args: { groupId: v.id("groups"), otherUserId: v.id("users") },
  handler: async (ctx, { groupId, otherUserId }) => {
    const { userId } = await requireMembership(ctx, groupId);
    if (userId === otherUserId) throw new ConvexError({ code: ERROR.CANNOT_SETTLE_SELF });

    const unsettled = await ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", false))
      .collect();

    // jen podíly mezi námi dvěma, v obou směrech
    const between = unsettled.filter(
      (s) =>
        (s.userId === userId && s.payerId === otherUserId) ||
        (s.userId === otherUserId && s.payerId === userId),
    );
    if (between.length === 0) return null;

    const now = Date.now();

    const net = aggregateDebts(
      between.map((s) => ({ debtorId: s.userId as string, creditorId: s.payerId as string, amount: s.amount })),
    );

    if (net.length === 0) {
      // po vyrušení nikdo nikomu nic nedluží — jen zavřeme podíly, žádný
      // settlements řádek (peníze reálně nikam nepřešly)
      await Promise.all(between.map((s) => ctx.db.patch(s._id, { settled: true, settledAt: now })));
      return null;
    }

    const [{ from, to, amount }] = net; // jen dva lidi ve vstupu → nejvýš jeden netted řádek
    const settlementId = await ctx.db.insert("settlements", {
      groupId,
      fromUserId: from as Id<"users">,
      toUserId: to as Id<"users">,
      amount,
      createdBy: userId,
      createdAt: now,
    });

    await Promise.all(
      between.map((s) => ctx.db.patch(s._id, { settled: true, settledAt: now, settlementId })),
    );

    return settlementId;
  },
});

/**
 * Zruší hromadné vyrovnání založené `settleAllWith` s nenulovým rozdílem:
 * u každého podílu, který na sobě nese jeho `settlementId` (dohledá přes
 * `by_settlementId`, ne skenem celé party), vrátí `settled`/`settledAt`/
 * `settlementId` zpátky na výchozí stav, a smaže samotný `settlements`
 * řádek (žádná jiná tabulka na jeho `_id` neukazuje, takže po zrušení
 * vyrovnání nemá co evidovat).
 *
 * Oprávnění: jen jedna ze dvou stran vyrovnání (`fromUserId`/`toUserId`) —
 * stejné pravidlo jako u `settleSplit`/`unsettleSplit`, přenesené na
 * hromadný záznam.
 */
export const unsettleSettlement = mutation({
  args: { settlementId: v.id("settlements") },
  handler: async (ctx, { settlementId }) => {
    // requireUser dřív než čtení vyrovnání — stejný důvod jako u settleSplit.
    const userId = await requireUser(ctx);
    const settlement = await ctx.db.get(settlementId);
    if (settlement === null) throw new ConvexError({ code: ERROR.SETTLEMENT_NOT_FOUND });
    await requireMembership(ctx, settlement.groupId);

    if (userId !== settlement.fromUserId && userId !== settlement.toUserId) {
      throw new ConvexError({ code: ERROR.DEBT_NOT_YOURS });
    }

    const covered = await ctx.db
      .query("splits")
      .withIndex("by_settlementId", (q) => q.eq("settlementId", settlementId))
      .collect();

    await Promise.all(
      covered.map((s) =>
        ctx.db.patch(s._id, { settled: false, settledAt: undefined, settlementId: undefined }),
      ),
    );
    await ctx.db.delete(settlementId);

    return null;
  },
});

/** Historie vyrovnání party, od nejnovějšího, s přezdívkami obou stran. */
export const listForGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requireMembership(ctx, groupId);
    const rows = await ctx.db
      .query("settlements")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .order("desc")
      .collect();

    const members = await memberLookup(ctx, groupId);
    return rows.map((s) => ({
      ...s,
      fromNickname: members.get(s.fromUserId)?.nickname ?? "Někdo",
      toNickname: members.get(s.toUserId)?.nickname ?? "Někdo",
    }));
  },
});
