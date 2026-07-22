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
🎬 Діаграма `pipeline.svg` («How it works») — по черзі підсвічуються стадії: predicate → prepay escrow → matcher → webhook/MCP → on-chain receipt.
🎤 "Write a JSON rule. Prepay in CSPR into an on-chain escrow contract. Sluice watches the chain, and the instant a matching event lands it pushes it to your webhook — median under ~150 ms on testnet — and writes an auditable receipt back on chain."

### ③ 0:35–1:05 · Чесний дашборд
🎬 `/app`, вкладка Subscriptions. Пройтись по стат-бару: **FUNDS LOCKED 30 CSPR · ACTIVE SUBS 6/7 (навести на підпис «1 escrow-backed · 5 demo») · EVENTS DELIVERED 11 · WEBHOOK HEALTH 100%**. Потім у таблиці навести на реальний лейн **`sub_0003`** (30 CSPR, `ecf442…7309`), далі — на лейн з маркером **`DEMO`** (показати tooltip «demo lanes POST but write no receipt»).
🎤 "Here's the live dashboard. Six lanes are active — but only one is escrow-backed: thirty CSPR locked, funded from a real wallet. The other five are clearly marked DEMO. They deliver real webhooks so you can watch the feed move, but they hold no escrow, so we never count them as locked funds or write a fake on-chain receipt. What you see is exactly what's on chain — nothing inflated."

### ④ 1:05–1:30 · Правило простою мовою (AI-builder)
🎬 `/app` → вкладка **Build**. Ввести в поле: **`transfers over 1000 CSPR to dc7252…787c9c`** → натиснути **Build →**. Праворуч сам пишеться PREDICATE JSON (`amount gte` + `to_account_hash eq`), внизу засвічується зелене **✓ MATCHES**.
> ⚠️ Знімай саме з порогом «over 1000 CSPR» — sample-подія має 5000 CSPR, тож matches зелений. Якщо сказати «100k CSPR», предикат розпарситься правильно, але sample покаже NO MATCH (0.005 % від порогу) — на камері це зайве.
🎤 "You don't hand-write JSON. Describe the rule in plain English — 'transfers over a thousand CSPR to this address' — and the builder compiles it to a predicate right in the browser. Test it against a sample event: it matches."

### ⑤ 1:30–2:00 · Живий swap end-to-end
🎬 Термінал: **`scripts/demo-swap.sh 500000 CSPR USDC`**. Повертаєшся на `/app` (або `/feed`) — у стрічці за кілька секунд з'являється новий рядок **`Contract · Swap @ ffb5a9… → 200 · ~80 ms`**.
> ⚠️ Фіналізація на testnet інколи до 1–2 хв. Запусти swap трохи заздалегідь і зроби cut на момент, коли рядок падає — не тримай очікування в кадрі. (Перевірено: реальна транзакція, доставка status 200, ~74 ms.)
🎤 "This isn't a mock. I'll fire a real swap on our DemoDex contract on testnet. The production matcher is watching it — swap transaction, to CSPR.cloud's stream, to a predicate match, to a webhook two-hundred — and there it is in the feed, a real matched event in seconds."

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
