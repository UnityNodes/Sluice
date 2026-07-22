# Sluice — сценарій зйомки демо (показувати / говорити)

> Ціль ~2:45. Знімати живий продукт на sluice.unitynodes.com (incognito, cache-bust).
> Замінює demo-sluice.mp4 (нечесні `230 CSPR` / `6 active` без розбивки).
> Кожен beat перевірено наживо 2026-07-22. **🎬 = що показувати (укр) · 🎤 = що казати (англ).**

**Чесні числа для звірки перед дублями (не має бути іншого):**
`FUNDS LOCKED 30 CSPR` · `ACTIVE SUBS 6 / 7 · «1 escrow-backed · 5 demo»` · `EVENTS DELIVERED 11` · `WEBHOOK HEALTH 100%` · badge `11 on-chain · 1 active` · contract `f3710e…b971`.

---

### ① 0:00–0:15 · Хук
🎬 Лендінг `/`, повільний скрол повз заголовок **«Stripe webhooks, but for Casper.»**
🎤 "You're building an app or an AI agent on Casper, and you need to know the instant something happens on chain. Ethereum has Alchemy webhooks. Solana has Helius. Casper had nothing — Sluice fills that gap."

### ② 0:15–0:35 · Як працює
🎬 На лендінгу проскрол до секції **«How it works»** (пункт меню «How it works») — там діаграма-конвеєр: **Source → Matcher → Your webhook + On-chain receipt**, з анімованим імпульсом по лініях. Дай кадру затриматись на ній.
🎤 "Write a JSON rule. Prepay in CSPR into an on-chain escrow contract. Sluice watches the chain, and the instant a matching event lands it pushes it to your webhook — median under ~150 ms on testnet — and writes an auditable receipt back on chain."

### ③ 0:35–1:05 · Чесний дашборд
🎬 `/app`, вкладка Subscriptions. Пройтись по стат-бару: **FUNDS LOCKED 30 CSPR · ACTIVE SUBS 6/7 (навести на підпис «1 escrow-backed · 5 demo») · EVENTS DELIVERED 11 · WEBHOOK HEALTH 100%**. Потім у таблиці навести на реальний лейн **`sub_0003`** (30 CSPR, `ecf442…7309`), далі — на лейн з маркером **`DEMO`** (показати tooltip «demo lanes POST but write no receipt»).
🎤 "Here's the live dashboard. Six lanes are active — but only one is escrow-backed: thirty CSPR locked, funded from a real wallet. The other five are clearly marked DEMO. They deliver real webhooks so you can watch the feed move, but they hold no escrow, so we never count them as locked funds or write a fake on-chain receipt. What you see is exactly what's on chain — nothing inflated."

### ④ 1:05–1:30 · Правило простою мовою (AI-builder)
🎬 `/app` → вкладка **Build**. Ввести в поле: **`transfers over 1000 CSPR to dc7252…787c9c`** → натиснути **Build →**. Праворуч сам пишеться PREDICATE JSON (`amount gte` + `to_account_hash eq`), внизу засвічується зелене **✓ MATCHES**.
> ⚠️ Знімай саме з порогом «over 1000 CSPR» — sample-подія має 5000 CSPR, тож matches зелений. Якщо сказати «100k CSPR», предикат розпарситься правильно, але sample покаже NO MATCH (0.005 % від порогу) — на камері це зайве.
🎤 "You don't hand-write JSON. Describe the rule in plain English — 'transfers over a thousand CSPR to this address' — and the builder compiles it to a predicate right in the browser. Test it against a sample event: it matches."

### ⑤ 1:30–2:00 · Жива доставка — усе з браузера (без терміналу)
🎬 `/app` → вкладка **Sandbox**. Поле **WEBHOOK URL** уже заповнене вбудованим приймачем (`/api/hooks/sandbox-…` — нічого налаштовувати), рецепт «any recent transfer», COUNT лишити на 3 → натиснути **▶ Fire 3 webhooks**. Внизу в **DISPATCH RESULTS** миттєво з'являються 3 рядки: `#1 200 · 100 ms`, `#2 200 · 52 ms`, `#3 200 · …` — кожен зі своїм підпис-хешем. Далі переклацни на **Live feed** (меню «Live feed» / сторінка `/feed`) — там реальні on-chain рядки **`Contract · Swap @ ffb5a9… → 200`** падають самі.
> ⚠️ Жодного терміналу — усе з сайту. Sandbox дає результат миттєво (натиснув → одразу 200 + латентність + підпис). Він чесно позначений «NO CSPR · no on-chain effect» — це тестові POST-и, тому НЕ називай їх on-chain. Рядки `Swap` у стрічці — навпаки, справжні on-chain матчі (DemoDex, з'являються автоматично кожні ~15 хв); саме їх називай «real on-chain».
🎤 "And it all runs from the browser — no CLI, no wallet. I hit Fire, and Sluice sends real, HMAC-signed webhook POSTs straight to your endpoint — there they land, two-hundreds in tens of milliseconds. That's how you harden your receiver before you pay a cent. And over here in the live feed, these rows are real on-chain DemoDex swaps the production matcher caught and delivered — landing on their own."

### ⑥ 2:00–2:25 · On-chain проф + x402
🎬 Показати на cspr.live реальний **`record_delivery`** деплой (`error: None`) — auditable ledger. Далі панель **x402** на `/app` («Subscription 200 … 0.1 WCSPR micropayment»).
> ⚠️ **x402 живим one-click кліком у кадрі НЕ демонструвати** — буфер sub 200 наповнюється лише подією під його предикат, і на холодну кнопка чесно каже «no matched event available». Безпечно: наведи на панель + покажи **готове** попереднє on-chain settlement на cspr.live (кадри зі старого відео ще валідні). Якщо все ж треба живий пул — спершу на репетиції домогтися успішного сеттлменту й лише тоді писати дубль.
🎤 "And the billing is real too. Every escrow-backed delivery is a deploy on Casper — your bill is an auditable ledger on cspr.live, not an invoice we made up. This lane is even paid per delivery over x402: each pull settles a point-one WCSPR micropayment through Casper's hosted facilitator, no wallet needed."

### ⑦ 2:25–2:40 · MCP / агенти
🎬 На `/app` картка «For AI agents» + кнопка копіювання **`https://sluice.unitynodes.com/mcp`**. Опційно: MCP-клієнт (Claude/Cursor), що лістить інструменти Sluice.
🎤 "Casper's AI Toolkit lets an agent read chain state, act on it, and pay per request. The missing piece was react. Sluice ships as one hosted MCP URL — any agent installs it and gets matched events pushed in as tool calls."

### ⑧ 2:40–2:50 · Фінал
🎬 Хедер `/app`: badge **`11 on-chain · 1 active`**, `contract f3710e…b971 on cspr.live`. Ендкард: **sluice.unitynodes.com**.
🎤 "Live on Casper testnet today. One contract, one hosted MCP, honest on-chain numbers. Sluice — the react primitive for Casper."

---

### Короткий різ 60–90 с
Beats **① → ③ → ⑤ → ⑥ → ⑧**: проблема → чесний дашборд → живий swap → on-chain проф → фінал. Beats ④ (builder) і ⑦ (MCP) — пропустити.
