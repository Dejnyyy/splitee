import { expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { signedInAs } from "../../tests/convexHelpers";
import { setupGroup } from "../../tests/fixtures";
import { MEMBER_COLORS } from "../../lib/colors";

const MEMBER_COLOR_KEYS = MEMBER_COLORS.map((c) => c.key);

const DEN = new Date("2026-09-10T12:00:00Z").getTime();

/** Dejny zaplatil 100 Kč, skládají se on a Petr → Petr mu dluží 50 Kč. */
async function pizzaZaStovku() {
  const ctx = await setupGroup();
  await ctx.dejny.asUser.mutation(api.expenses.create, {
    groupId: ctx.groupId,
    payerId: ctx.dejny.userId,
    amount: 10000,
    title: "Pizza",
    categoryId: ctx.categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: ctx.dejny.userId }, { userId: ctx.petr.userId }],
  });
  return ctx;
}

async function petrovSplitId(
  t: Awaited<ReturnType<typeof setupGroup>>["t"],
  groupId: Id<"groups">,
  petrId: Id<"users">,
) {
  return t.run(async (ctx) => {
    const split = await ctx.db
      .query("splits")
      .withIndex("by_group_user_settled", (q) =>
        q.eq("groupId", groupId).eq("userId", petrId).eq("settled", false),
      )
      .first();
    return split!._id;
  });
}

test("nevyrovnaný podíl se objeví jako dluh správným směrem", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({
    from: petr.userId,
    to: dejny.userId,
    amount: 5000,
    fromNickname: "Petr",
    toNickname: "Dejny",
    splitIds: [splitId],
  });
  expect(MEMBER_COLOR_KEYS).toContain(debts[0].fromColor);
  expect(MEMBER_COLOR_KEYS).toContain(debts[0].toColor);
});

test("vyrovnání jednoho podílu dluh odstraní", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await dejny.asUser.mutation(api.settlements.settleSplit, { splitId });

  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);
});

test("vyrovnat smí jen dlužník nebo věřitel, ne přihlížející", async () => {
  const { t, groupId, jana, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await expect(jana.asUser.mutation(api.settlements.settleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "DEBT_NOT_YOURS" },
  });
});

// Review round 1, Finding 5: settleSplit/unsettleSplit/settleAllWith/
// unsettleSettlement hýbou penězi, ale jen debts/listForGroup měly test na
// nečlena — čtyři testy níž (rozeseté ke svým mutacím) tuhle díru zavírají.
test("nečlen podíl nevyrovná", async () => {
  const { t, groupId, petr } = await pizzaZaStovku();
  const cizi = await signedInAs(t, { nickname: "Cizí" });
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await expect(cizi.asUser.mutation(api.settlements.settleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "NOT_MEMBER" },
  });
});

test("vzájemné dluhy se vyruší na jednu kartu", async () => {
  const { groupId, dejny, petr, categoryId } = await pizzaZaStovku();

  // Petr zaplatí 40 Kč za oba → Dejny mu dluží 20, proti tomu Petr dluží 50
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({ from: petr.userId, to: dejny.userId, amount: 3000 });
});

test("vyrovnat vše označí podíly v obou směrech a založí jeden záznam", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();

  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  const settlementId = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });

  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);

  const settlement = await t.run(async (ctx) => ctx.db.get(settlementId!));
  expect(settlement).toMatchObject({
    fromUserId: petr.userId,
    toUserId: dejny.userId,
    amount: 3000, // net, ne hrubých 5000
  });

  const leftover = await t.run(async (ctx) =>
    ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", false))
      .collect(),
  );
  expect(leftover).toEqual([]);
});

test("vyrovnat vše nesahá na dluhy vůči třetímu člověku", async () => {
  const { groupId, dejny, petr, jana, categoryId } = await pizzaZaStovku();

  await dejny.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: dejny.userId,
    amount: 6000,
    title: "Benzín",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: jana.userId }],
  });

  await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });

  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({ from: jana.userId, to: dejny.userId, amount: 3000 });
});

test("vyrovnat vše bez dluhu nic nezaloží", async () => {
  const { groupId, dejny, jana } = await pizzaZaStovku();

  const result = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: jana.userId,
  });

  expect(result).toBeNull();
});

// Review round 1, Finding 5: každý dosavadní settleAllWith test volal
// věřitel (dejny). Tenhle dokazuje, že směr výsledného settlements řádku
// určuje čistý dluh, ne to, kdo mutaci zavolal — dlužník (petr) zavolá
// settleAllWith a řádek pořád míří od petra k dejnymu.
test("vyrovnat vše funguje stejně, ať volá dlužník nebo věřitel", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();

  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  // volá petr (dlužník v čistém součtu), ne dejny (věřitel) jako ve všech
  // ostatních testech výš
  const settlementId = await petr.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: dejny.userId,
  });

  const settlement = await t.run(async (ctx) => ctx.db.get(settlementId!));
  expect(settlement).toMatchObject({ fromUserId: petr.userId, toUserId: dejny.userId, amount: 3000 });
  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);
});

// Review round 1, Finding 5: "implicitně self-scoped" tvrzení z reportu —
// volající není součástí dvojice → není co vyrovnávat, dluh třetí strany
// zůstává nedotčený, i když jde přesně o ten pár, co settleAllWith dostal.
test("vyrovnat vše nejde mezi dvěma jinými lidmi, i když je volající zná", async () => {
  const { groupId, dejny, petr, jana } = await pizzaZaStovku();

  // jana není v dluhu petr→dejny vůbec zapojená, přesto zkusí "vyrovnat"
  // právě tenhle cizí pár
  const result = await jana.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });
  expect(result).toBeNull();

  // dluh petr→dejny z pizzy přežil beze změny
  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({ from: petr.userId, to: dejny.userId, amount: 5000 });
});

test("nečlen vyrovnat vše nezavolá", async () => {
  const { t, groupId, petr } = await pizzaZaStovku();
  const cizi = await signedInAs(t, { nickname: "Cizí" });

  await expect(
    cizi.asUser.mutation(api.settlements.settleAllWith, { groupId, otherUserId: petr.userId }),
  ).rejects.toMatchObject({ data: { code: "NOT_MEMBER" } });
});

test("nečlen dluhy party nevidí", async () => {
  const { t, groupId } = await pizzaZaStovku();
  const cizi = await signedInAs(t, { nickname: "Cizí" });

  await expect(cizi.asUser.query(api.settlements.debts, { groupId })).rejects.toMatchObject({
    data: { code: "NOT_MEMBER" },
  });
});

// --- settleAllWith s přesně nulovým rozdílem — dluhy se vyruší, ale žádný
// settlements řádek nevzniká (stejný případ, na který se odvolává komentář
// u deleteSplits v convex/expenses.ts: "settleAllWith u nulového zůstatku,
// nikdy settlementId nenastaví"). ---

test("vyrovnat vše s přesně nulovým rozdílem nezaloží settlements řádek, jen zavře podíly", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();

  // Petr zaplatí přesně 100 Kč jen za sebe a Dejnyho → Dejny mu dluží 50,
  // proti tomu Petr dluží 50 z pizzy → čistý rozdíl je nula.
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 10000,
    title: "Oplátka",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);

  const result = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });
  expect(result).toBeNull();

  const settlementRows = await t.run(async (ctx) =>
    ctx.db
      .query("settlements")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect(),
  );
  expect(settlementRows).toEqual([]);

  const leftover = await t.run(async (ctx) =>
    ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", false))
      .collect(),
  );
  expect(leftover).toEqual([]);
});

// Review round 1, Finding 1: podíly z nulového rozdílu jsou jediná dávka bez
// `settlementId` — pojistka, že `unsettleSplit` do nich pořád umí sáhnout.
// Kdyby nějaký budoucí refaktor "kvůli konzistenci" začal i téhle větvi
// přidávat settlementId, unsettleSplit by na ní spadl na
// SPLIT_PART_OF_SETTLEMENT a unsettleSettlement na SETTLEMENT_NOT_FOUND
// (žádný settlements řádek neexistuje) — trvale zamčený výdaj bez cesty ven.
test("nulově vyrovnaný podíl jde vrátit přes unsettleSplit a odkryje původní hrubý dluh", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();

  // Petr zaplatí přesně 100 Kč jen za sebe a Dejnyho → čistý rozdíl s pizzou je nula.
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 10000,
    title: "Oplátka",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  await dejny.asUser.mutation(api.settlements.settleAllWith, { groupId, otherUserId: petr.userId });
  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);

  // Petrův podíl z pizzy (petr dluží dejnymu 5000) je settled bez settlementId
  const pizzaSplitId = await t.run(async (ctx) => {
    const split = await ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", true))
      .filter((q) => q.eq(q.field("userId"), petr.userId))
      .first();
    return split!._id;
  });
  const pizzaSplitBeforeUnsettle = await t.run(async (ctx) => ctx.db.get(pizzaSplitId));
  expect(pizzaSplitBeforeUnsettle?.settlementId).toBeUndefined();

  await petr.asUser.mutation(api.settlements.unsettleSplit, { splitId: pizzaSplitId });

  // odkrytý, dejnyho oplátkový podíl zůstává settled → jen pizza je zase dluh
  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({ from: petr.userId, to: dejny.userId, amount: 5000 });
});

test("vyrovnat sám se sebou neprojde", async () => {
  const { groupId, dejny } = await pizzaZaStovku();

  await expect(
    dejny.asUser.mutation(api.settlements.settleAllWith, { groupId, otherUserId: dejny.userId }),
  ).rejects.toMatchObject({ data: { code: "CANNOT_SETTLE_SELF" } });
});

test("opakované vyrovnání stejného podílu je no-op", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await dejny.asUser.mutation(api.settlements.settleSplit, { splitId });
  await expect(dejny.asUser.mutation(api.settlements.settleSplit, { splitId })).resolves.toBeNull();

  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);
});

test("vyrovnat neexistující podíl selže", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);
  await t.run(async (ctx) => ctx.db.delete(splitId));

  await expect(dejny.asUser.mutation(api.settlements.settleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "SPLIT_NOT_FOUND" },
  });
});

// --- Unsettle: Task 6 zamyká úpravu/smazání výdaje na vyrovnaném podílu a
// hláška uživatele posílá "nejdřív zruš vyrovnání" — bez týhle mutace by ten
// zámek byl slepá ulička. Kdo smí vyrovnat, smí i zrušit vyrovnání. ---

test("zrušení jednotlivého vyrovnání vrátí dluh zpět", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await dejny.asUser.mutation(api.settlements.settleSplit, { splitId });
  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);

  await petr.asUser.mutation(api.settlements.unsettleSplit, { splitId });

  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toEqual([{
    from: petr.userId,
    to: dejny.userId,
    amount: 5000,
    splitIds: [splitId],
    fromNickname: "Petr",
    fromColor: expect.stringMatching(new RegExp(`^(${MEMBER_COLOR_KEYS.join("|")})$`)),
    toNickname: "Dejny",
    toColor: expect.stringMatching(new RegExp(`^(${MEMBER_COLOR_KEYS.join("|")})$`)),
  }]);

  const split = await t.run(async (ctx) => ctx.db.get(splitId));
  expect(split?.settled).toBe(false);
  expect(split?.settledAt).toBeUndefined();
});

test("zrušit vyrovnání smí jen dlužník nebo věřitel, ne přihlížející", async () => {
  const { t, groupId, dejny, petr, jana } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);
  await dejny.asUser.mutation(api.settlements.settleSplit, { splitId });

  await expect(jana.asUser.mutation(api.settlements.unsettleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "DEBT_NOT_YOURS" },
  });
});

test("nečlen zrušení vyrovnání podílu nezavolá", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);
  await dejny.asUser.mutation(api.settlements.settleSplit, { splitId });
  const cizi = await signedInAs(t, { nickname: "Cizí" });

  await expect(cizi.asUser.mutation(api.settlements.unsettleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "NOT_MEMBER" },
  });
});

test("zrušení nikdy nevyrovnaného podílu je no-op", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);

  await expect(dejny.asUser.mutation(api.settlements.unsettleSplit, { splitId })).resolves.toBeNull();
  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toHaveLength(1);
});

test("zrušení vyrovnání na neexistujícím podílu selže", async () => {
  const { t, groupId, dejny, petr } = await pizzaZaStovku();
  const splitId = await petrovSplitId(t, groupId, petr.userId);
  await t.run(async (ctx) => ctx.db.delete(splitId));

  await expect(dejny.asUser.mutation(api.settlements.unsettleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "SPLIT_NOT_FOUND" },
  });
});

test("plátcův vlastní podíl nejde zrušit vyrovnáním, není to dluh", async () => {
  const { t, groupId, dejny } = await pizzaZaStovku();
  const payerSplitId = await t.run(async (ctx) => {
    const split = await ctx.db
      .query("splits")
      .withIndex("by_group_user_settled", (q) =>
        q.eq("groupId", groupId).eq("userId", dejny.userId).eq("settled", true),
      )
      .first();
    return split!._id;
  });

  await expect(
    dejny.asUser.mutation(api.settlements.unsettleSplit, { splitId: payerSplitId }),
  ).rejects.toMatchObject({ data: { code: "PAYER_SPLIT_NOT_A_DEBT" } });
});

test("podíl z hromadného vyrovnání nejde zrušit jednotlivě, jen celé", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  await dejny.asUser.mutation(api.settlements.settleAllWith, { groupId, otherUserId: petr.userId });
  const splitId = await t.run(async (ctx) => {
    const split = await ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", true))
      .filter((q) => q.eq(q.field("userId"), petr.userId))
      .first();
    return split!._id;
  });

  await expect(dejny.asUser.mutation(api.settlements.unsettleSplit, { splitId })).rejects.toMatchObject({
    data: { code: "SPLIT_PART_OF_SETTLEMENT" },
  });
});

test("zrušení hromadného vyrovnání vrátí všechny podíly i dluh", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  const settlementId = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });
  expect(await dejny.asUser.query(api.settlements.debts, { groupId })).toEqual([]);

  await petr.asUser.mutation(api.settlements.unsettleSettlement, { settlementId: settlementId! });

  const debts = await dejny.asUser.query(api.settlements.debts, { groupId });
  expect(debts).toHaveLength(1);
  expect(debts[0]).toMatchObject({ from: petr.userId, to: dejny.userId, amount: 3000 });

  expect(await t.run(async (ctx) => ctx.db.get(settlementId!))).toBeNull();

  const stillLinked = await t.run(async (ctx) =>
    ctx.db
      .query("splits")
      .withIndex("by_group_settled", (q) => q.eq("groupId", groupId).eq("settled", true))
      .collect(),
  );
  // po zrušení zůstává settled jen plátcův vlastní podíl (settlementId undefined)
  expect(stillLinked.every((s) => s.settlementId === undefined)).toBe(true);
});

test("zrušit hromadné vyrovnání smí jen jedna ze zúčastněných stran", async () => {
  const { groupId, dejny, petr, jana, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });

  const settlementId = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });

  await expect(
    jana.asUser.mutation(api.settlements.unsettleSettlement, { settlementId: settlementId! }),
  ).rejects.toMatchObject({ data: { code: "DEBT_NOT_YOURS" } });
});

test("nečlen zrušení hromadného vyrovnání nezavolá", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });
  const settlementId = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });
  const cizi = await signedInAs(t, { nickname: "Cizí" });

  await expect(
    cizi.asUser.mutation(api.settlements.unsettleSettlement, { settlementId: settlementId! }),
  ).rejects.toMatchObject({ data: { code: "NOT_MEMBER" } });
});

test("zrušení neexistujícího vyrovnání selže", async () => {
  const { t, groupId, dejny, petr, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });
  const settlementId = await dejny.asUser.mutation(api.settlements.settleAllWith, {
    groupId,
    otherUserId: petr.userId,
  });
  await t.run(async (ctx) => ctx.db.delete(settlementId!));

  await expect(
    dejny.asUser.mutation(api.settlements.unsettleSettlement, { settlementId: settlementId! }),
  ).rejects.toMatchObject({ data: { code: "SETTLEMENT_NOT_FOUND" } });
});

test("historie vyrovnání vrací přezdívky obou stran", async () => {
  const { groupId, dejny, petr, categoryId } = await pizzaZaStovku();
  await petr.asUser.mutation(api.expenses.create, {
    groupId,
    payerId: petr.userId,
    amount: 4000,
    title: "Kafe",
    categoryId,
    spentAt: DEN,
    splitMode: "equal",
    participants: [{ userId: dejny.userId }, { userId: petr.userId }],
  });
  await dejny.asUser.mutation(api.settlements.settleAllWith, { groupId, otherUserId: petr.userId });

  const history = await dejny.asUser.query(api.settlements.listForGroup, { groupId });
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    fromUserId: petr.userId,
    toUserId: dejny.userId,
    amount: 3000,
    fromNickname: "Petr",
    toNickname: "Dejny",
  });
});

test("nečlen historii vyrovnání party nevidí", async () => {
  const { t, groupId } = await pizzaZaStovku();
  const cizi = await signedInAs(t, { nickname: "Cizí" });

  await expect(cizi.asUser.query(api.settlements.listForGroup, { groupId })).rejects.toMatchObject({
    data: { code: "NOT_MEMBER" },
  });
});
