// backend/controllers/KrogerController.js
import axios from "axios";
import crypto from "crypto";
import openai from "../config/openai.js";
import Kroger from "../config/kroger.js";
import User from "../models/User.js";
import { redis } from "../config/redis.js";
import {
  rawSearch as walmartRawSearch,
  normalize as normalizeWalmart,
} from "../config/walmartAffiliate.js";

import { buildBudgetSearchGraphRunner } from "./budgetSearchGraph.js";
import { buildAgenticSearchGraphRunner } from "./agenticSearchGraph.js";

/* ============================== Debug Helpers ============================== */

const DEBUG = String(process.env.SMART_ECOM_DEBUG || "").trim() === "1";

function safeShort(v, max = 500) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length <= max) return s;
    return s.slice(0, max) + "…(truncated)";
  } catch {
    return String(v);
  }
}

// Redact anything that looks like an access token
function redact(obj) {
  try {
    const s = JSON.stringify(obj);
    return JSON.parse(
      s.replace(
        /("accessToken"\s*:\s*")([^"]+)(")/gi,
        `$1***redacted***$3`
      )
    );
  } catch {
    return obj;
  }
}

function mkLogger(requestId, extra = {}) {
  return {
    info: (msg, meta) => {
      if (!DEBUG) return;
      console.log(`[SmartEcom:${requestId}] ${msg}`, redact(meta ?? extra));
    },
    warn: (msg, meta) => {
      if (!DEBUG) return;
      console.warn(`[SmartEcom:${requestId}] ${msg}`, redact(meta ?? extra));
    },
    error: (msg, meta) => {
      if (!DEBUG) return;
      console.error(`[SmartEcom:${requestId}] ${msg}`, redact(meta ?? extra));
    },
  };
}

/* ============================== Helpers ============================== */
function safeJSONParse(text, fallback) {
  try {
    if (text && typeof text === "object") return text;
    const cleaned = String(text)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "");
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const t = normText(s);
  const parts = t.split(" ").filter(Boolean);
  return new Set(parts);
}

function tokenOverlap(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

function looksLikeCovered(fridgeItems, ingredient, productTitle) {
  const ing = normText(ingredient);
  const title = normText(productTitle);

  for (const item of fridgeItems) {
    const it = normText(item);
    if (!it) continue;

    if (ing.includes(it) || it.includes(ing)) return true;
    if (title.includes(it)) return true;

    const ov1 = tokenOverlap(ingredient, item);
    const ov2 = tokenOverlap(productTitle, item);
    if (ov1 >= 0.66 || ov2 >= 0.66) return true;
  }
  return false;
}

function pickBestImage(p) {
  const prefOrder = ["xlarge", "large", "medium", "small", "thumbnail"];
  const imgs = Array.isArray(p.images) ? p.images : [];
  const front = imgs.find((i) => i.perspective === "front") || {};
  const sizes = [
    ...(front.sizes || []),
    ...imgs.filter((i) => i !== front).flatMap((i) => i.sizes || []),
  ];
  if (!sizes.length) return "";
  sizes.sort(
    (a, b) => prefOrder.indexOf(a.size || "") - prefOrder.indexOf(b.size || "")
  );
  return sizes[0]?.url || "";
}

function normalizeKroger(p, locationId) {
  const img = pickBestImage(p);
  const price =
    p.items?.[0]?.price?.promo ?? p.items?.[0]?.price?.regular ?? 0;
  const size = p.items?.[0]?.size || p.items?.[0]?.soldBy || "";
  return {
    _id: p.productId,
    title: p.description,
    imageUrl: img,
    price,
    category: p.categories?.[0] || "",
    description: p.brand,
    upc: p.upc,
    locationId,
    retailer: "kroger",
    size,
    raw: p,
  };
}

/* ===================== Budget compare helpers ===================== */
function parseUnitQuantityFromText(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  const t = s.replace(/×/g, "x");

  const mult = t.match(
    /\b(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(fl\s*oz|floz|oz|lb|g|kg|ml|l|ct|count|pk|pack)\b/
  );
  if (mult) {
    const a = Number(mult[1]);
    const b = Number(mult[2]);
    const unit = String(mult[3] || "").replace(/\s+/g, "");
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      const total = a * b;
      const parsedSingle = parseUnitQuantityFromText(`${total} ${unit}`);
      if (parsedSingle) return parsedSingle;
    }
  }

  const packOf = t.match(/\bpack\s*of\s*(\d+(?:\.\d+)?)\b/);
  if (packOf) {
    const n = Number(packOf[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "count", qty: n };
  }
  const count = t.match(/\b(\d+(?:\.\d+)?)\s*(ct|count)\b/);
  if (count) {
    const n = Number(count[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "count", qty: n };
  }
  const pk = t.match(/\b(\d+(?:\.\d+)?)\s*(pk|pack)\b/);
  if (pk) {
    const n = Number(pk[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "count", qty: n };
  }
  const dashPack = t.match(/\b(\d+(?:\.\d+)?)\s*-\s*pack\b/);
  if (dashPack) {
    const n = Number(dashPack[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "count", qty: n };
  }

  const flOz = t.match(/\b(\d+(?:\.\d+)?)\s*(fl\s*oz|floz)\b/);
  if (flOz) {
    const n = Number(flOz[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "volume_floz", qty: n };
  }
  const ml = t.match(/\b(\d+(?:\.\d+)?)\s*ml\b/);
  if (ml) {
    const n = Number(ml[1]);
    if (Number.isFinite(n) && n > 0)
      return { kind: "volume_floz", qty: n * 0.0338140227 };
  }
  const liter = t.match(/\b(\d+(?:\.\d+)?)\s*l\b/);
  if (liter) {
    const n = Number(liter[1]);
    if (Number.isFinite(n) && n > 0)
      return { kind: "volume_floz", qty: n * 33.8140227 };
  }

  const oz = t.match(/\b(\d+(?:\.\d+)?)\s*oz\b/);
  if (oz) {
    const n = Number(oz[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "weight_oz", qty: n };
  }
  const lb = t.match(/\b(\d+(?:\.\d+)?)\s*lb\b/);
  if (lb) {
    const n = Number(lb[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "weight_oz", qty: n * 16 };
  }
  const g = t.match(/\b(\d+(?:\.\d+)?)\s*g\b/);
  if (g) {
    const n = Number(g[1]);
    if (Number.isFinite(n) && n > 0)
      return { kind: "weight_oz", qty: n * 0.0352739619 };
  }
  const kg = t.match(/\b(\d+(?:\.\d+)?)\s*kg\b/);
  if (kg) {
    const n = Number(kg[1]);
    if (Number.isFinite(n) && n > 0)
      return { kind: "weight_oz", qty: n * 35.2739619 };
  }

  return null;
}

function bestComparableOffer(products = []) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return null;

  let best = null;

  for (const p of list) {
    const price = typeof p?.price === "number" ? p.price : Number(p?.price || 0);
    const title = p?.title || "";
    const size = p?.size || "";
    const raw = p?.raw || null;

    const candidates = [];
    if (size) candidates.push(size);

    if (raw && typeof raw === "object") {
      const maybe = [
        raw?.size,
        raw?.sizeString,
        raw?.packageSize,
        raw?.packSize,
        raw?.name,
      ]
        .map((x) => (typeof x === "string" ? x : ""))
        .filter(Boolean);
      candidates.push(...maybe);
    }
    candidates.push(title);

    let parsed = null;
    for (const c of candidates) {
      parsed = parseUnitQuantityFromText(c);
      if (parsed) break;
    }

    const hasUnit = parsed && parsed.qty > 0;
    const unitPrice = hasUnit ? price / parsed.qty : null;

    const offer = {
      product: p,
      price: Number.isFinite(price) ? price : 0,
      unitKind: hasUnit ? parsed.kind : null,
      unitQty: hasUnit ? parsed.qty : null,
      unitPrice: hasUnit && Number.isFinite(unitPrice) ? unitPrice : null,
      basis: hasUnit ? "unit" : "price",
    };

    if (!best) {
      best = offer;
      continue;
    }

    if (
      offer.unitPrice !== null &&
      best.unitPrice !== null &&
      offer.unitKind === best.unitKind
    ) {
      if (offer.unitPrice < best.unitPrice) best = offer;
      continue;
    }

    if (offer.price < best.price) best = offer;
  }

  return best;
}

function chooseWinnerForIngredient(kArr, wArr) {
  const krogerBest = bestComparableOffer(kArr);
  const walmartBest = bestComparableOffer(wArr);

  if (krogerBest && !walmartBest) {
    return { winner: "kroger", krogerBest, walmartBest, reason: "only_kroger" };
  }
  if (!krogerBest && walmartBest) {
    return { winner: "walmart", krogerBest, walmartBest, reason: "only_walmart" };
  }
  if (!krogerBest && !walmartBest) {
    return { winner: "none", krogerBest: null, walmartBest: null, reason: "none" };
  }

  if (
    krogerBest.unitPrice !== null &&
    walmartBest.unitPrice !== null &&
    krogerBest.unitKind === walmartBest.unitKind
  ) {
    if (krogerBest.unitPrice <= walmartBest.unitPrice) {
      return { winner: "kroger", krogerBest, walmartBest, reason: "unit_price" };
    }
    return { winner: "walmart", krogerBest, walmartBest, reason: "unit_price" };
  }

  if (krogerBest.price <= walmartBest.price) {
    return { winner: "kroger", krogerBest, walmartBest, reason: "price_fallback" };
  }
  return { winner: "walmart", krogerBest, walmartBest, reason: "price_fallback" };
}

/* ===================== Responses API Utils ===================== */
function buildResponsesInput(messages) {
  return messages.map(({ role, content }) => ({
    role,
    content: [{ type: "input_text", text: String(content ?? "") }],
  }));
}

function extractResponsesText(resp) {
  if (typeof resp?.output_text === "string" && resp.output_text.length)
    return resp.output_text;

  const source = resp?.output || resp?.data?.output || [];
  const parts = [];
  for (const item of source) {
    for (const c of item?.content || []) {
      if (typeof c?.parsed !== "undefined") return c.parsed;
      if (typeof c?.json !== "undefined") return c.json;
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      else if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

async function callGPT5JSON(messages, { maxTokens = 4000, schema = null } = {}) {
  const input = buildResponsesInput(messages);
  const textFormat = schema
    ? { type: "json_schema", name: schema.name, strict: true, schema: schema.schema }
    : { type: "json_object" };

  if (!(openai && typeof openai.responses?.create === "function")) {
    throw new Error(
      'OpenAI SDK does not support Responses API. Please upgrade the "openai" package.'
    );
  }

  const payload = {
    model: "gpt-5",
    input,
    top_p: 1,
    max_output_tokens: maxTokens,
    reasoning: { effort: "low" },
    text: { format: textFormat, verbosity: "low" },
  };

  if (payload.text.format?.type === "json_schema") {
    const sch = payload.text.format.schema;
    const keys = Object.keys(sch?.properties || {});
    if (!Array.isArray(sch.required) || keys.some((k) => !sch.required.includes(k))) {
      sch.required = keys;
    }
  }

  const resp = await openai.responses.create(payload);
  return extractResponsesText(resp);
}

async function callGPT5VisionFridgeItems({ imageDataUrl }) {
  if (!(openai && typeof openai.responses?.create === "function")) {
    throw new Error(
      'OpenAI SDK does not support Responses API. Please upgrade the "openai" package.'
    );
  }

  const schema = {
    name: "fridge_items_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["items"],
    },
  };

  const resp = await openai.responses.create({
    model: "gpt-5",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "You are extracting groceries from a fridge/pantry photo. " +
              'Return ONLY JSON: {"items":[...]} where items are plain-English ingredient nouns (singular). ' +
              'Examples: "ginger", "garlic", "milk", "onion", "heavy cream", "tomato", "coriander". ' +
              "Exclude brand names, packaging text, and non-food objects. Keep it short (<= 30).",
          },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    max_output_tokens: 800,
    reasoning: { effort: "low" },
    text: {
      format: { type: "json_schema", name: schema.name, strict: true, schema: schema.schema },
    },
  });

  const raw = extractResponsesText(resp);
  const parsed = safeJSONParse(raw, { items: [] });
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 30);
}

/* ===================== Dish-level cache version ===================== */
const DISHCACHE_VERSION = "v2";

/* ===================== Shared Search Pipeline (Kroger) ===================== */
async function runKrogerSearchPipeline({
  query,
  zip,
  user,
  onPhase,
  onDebug,
  passCount = 20,
  chooseMax = 2,
  log,
}) {
  const sendPhase = (p) => {
    if (typeof onPhase === "function") onPhase(p);
  };
  const sendDebug = (obj) => {
    if (typeof onDebug === "function") onDebug(obj);
  };

  const qNorm = normText(query);
  const zipKey = (zip && String(zip).trim()) || "none";
  const fastKey = `dishcache:${DISHCACHE_VERSION}:q=${qNorm}:zip=${zipKey}:max=${Math.max(
    1,
    Math.min(2, chooseMax)
  )}`;

  log?.info("Kroger pipeline start", { query, zip, qNorm, fastKey });

  try {
    const fast = await redis.get(fastKey);
    if (fast) {
      const parsed = JSON.parse(fast);
      const hasIngredients = Array.isArray(parsed?.ingredients);
      const hasKrogerByIng =
        parsed?.krogerMatchedByIngredient &&
        typeof parsed.krogerMatchedByIngredient === "object";
      if (hasIngredients && hasKrogerByIng) {
        log?.info("dishcache HIT", {
          ingredientsCount: parsed?.ingredients?.length || 0,
          productsCount: parsed?.products?.length || 0,
        });
        sendDebug({
          where: "dishcache_hit",
          ingredientsCount: parsed?.ingredients?.length || 0,
          productsCount: parsed?.products?.length || 0,
        });
        return parsed;
      }
    }
  } catch (e) {
    log?.warn("dishcache read failed", { err: e?.message || String(e) });
  }

  sendPhase("finding");

  const messages1 = [
    { role: "system", content: "Return ONLY raw JSON as specified. No prose. No code fences." },
    {
      role: "user",
      content: `
Classify the user query as either (A) a prepared dish/recipe or (B) a single grocery ingredient, and respond as follows:

• If it is a single grocery ingredient (possibly in a regional language), translate to plain English and return ONLY:
  ["<ingredient>"]

• Otherwise, if it is a prepared dish/recipe, return ONLY:
  ["<dish name in English>", "<ingredient 1>", "<ingredient 2>", ...]

Output rules:
- Plain English nouns, singular
- Exclude water/brands/measurements
- Return ONLY: {"result":[...]}

Query: ${query}
      `.trim(),
    },
  ];

  const keyLLM1 = `llm1:ingredients:v1:model=gpt-5:q=${normText(query)}`;

  let dishName;
  let ingredients;

  const cachedLLM1 = await redis.get(keyLLM1);
  if (cachedLLM1) {
    const arr = JSON.parse(cachedLLM1);
    const dishDetected = Array.isArray(arr) && arr.length > 1;
    dishName = dishDetected ? arr[0] : null;
    ingredients = Array.isArray(arr) ? (dishDetected ? arr.slice(1) : arr) : [];
    log?.info("LLM1 cache HIT", { keyLLM1, dishName, ingredientsCount: ingredients.length });
    sendDebug({ where: "llm1_cache_hit", dishName, ingredients });
  } else {
    log?.info("LLM1 cache MISS -> calling OpenAI", { keyLLM1 });
    const llm1Raw = await callGPT5JSON(messages1, {
      maxTokens: 1200,
      schema: {
        name: "ingredients_payload",
        schema: {
          type: "object",
          properties: { result: { type: "array", items: { type: "string" } } },
          required: ["result"],
          additionalProperties: false,
        },
      },
    });

    const parsed1 = safeJSONParse(llm1Raw, { result: [] });
    const arr = Array.isArray(parsed1?.result) ? parsed1.result : [];
    const dishDetected = arr.length > 1;
    dishName = dishDetected ? arr[0] : null;
    ingredients = dishDetected ? arr.slice(1) : arr;

    log?.info("LLM1 result", {
      dishName,
      ingredientsCount: ingredients.length,
      rawPreview: safeShort(llm1Raw, 300),
    });
    sendDebug({ where: "llm1_result", dishName, ingredients });

    await redis.set(
      keyLLM1,
      JSON.stringify(dishDetected ? [dishName, ...ingredients] : ingredients),
      "EX",
      60 * 60 * 24 * 30
    );
  }

  if (!ingredients?.length) {
    log?.warn("No ingredients extracted", { query });
    const early = {
      products: [],
      warnings: ["no_ingredients"],
      dishName,
      ingredients: [],
      matchedInKroger: [],
      krogerCandidateCounts: {},
      krogerMatchedByIngredient: {},
    };
    try {
      await redis.set(fastKey, JSON.stringify(early));
    } catch {}
    return early;
  }

  sendPhase("fetching");

  const userDoc = user ? await User.findById(user._id).lean() : null;

  let locationId = null;
  try {
    locationId =
      userDoc?.kroger?.locationId ||
      (await Kroger.getLocationIdByZip(zip || process.env.KROGER_DEFAULT_ZIP));
  } catch (e) {
    log?.error("Failed to get Kroger locationId", {
      zip,
      defaultZip: process.env.KROGER_DEFAULT_ZIP,
      err: e?.message || String(e),
    });
  }

  log?.info("Using Kroger locationId", { locationId, zip });
  sendDebug({ where: "kroger_location", locationId, zip });

  const titlesByIng = {};
  const fullByIng = {};
  const warnings = [];

  for (const ing of ingredients) {
    try {
      const limit = Math.max(passCount, 20);
      const list = await Kroger.searchProductsByTerm(ing, {
        locationId,
        limit,
        allowNoLocationFallback: true,
      });

      fullByIng[ing] = list;
      titlesByIng[ing] = list.map((p) => p.description).slice(0, passCount);

      log?.info("Kroger candidates", {
        ingredient: ing,
        candidates: titlesByIng[ing].length,
        top3: titlesByIng[ing].slice(0, 3),
      });

      if ((titlesByIng[ing] || []).length === 0) {
        warnings.push({ ingredient: ing, error: "no_candidates" });
      }
    } catch (e) {
      const payload = e?.response?.data || e?.message || String(e);
      log?.error("Kroger search failed", { ingredient: ing, payload: safeShort(payload, 400) });
      warnings.push({ ingredient: ing, error: "product_search_failed", payload });
      fullByIng[ing] = [];
      titlesByIng[ing] = [];
    }
  }

  const ingList = ingredients.filter((i) => (titlesByIng[i] || []).length > 0);
  log?.info("Ingredients with candidates", { ingListCount: ingList.length, total: ingredients.length });
  sendDebug({ where: "kroger_candidates_summary", ingList, warnings });

  if (!ingList.length) {
    const early = {
      products: [],
      warnings: warnings.length ? warnings : ["no_candidates"],
      dishName,
      ingredients,
      matchedInKroger: [],
      krogerCandidateCounts: {},
      krogerMatchedByIngredient: {},
    };
    try {
      await redis.set(fastKey, JSON.stringify(early));
    } catch {}
    return early;
  }

  sendPhase("matching");

  const enumerated = {};
  for (const ing of ingList) {
    enumerated[ing] = titlesByIng[ing].map((t, idx) => `${idx}: ${t}`);
  }

  const fp = crypto
    .createHash("sha1")
    .update(JSON.stringify({ ingList, enumerated, chooseMax }))
    .digest("hex");
  const keyLLM2 = `llm2:match:v1:model=gpt-5:max=${Math.max(
    1,
    Math.min(2, chooseMax)
  )}:fp=${fp}`;

  let entries;
  const cachedLLM2 = await redis.get(keyLLM2);
  if (cachedLLM2) {
    const parsed2 = safeJSONParse(cachedLLM2, { final_picks: [] });
    entries = Array.isArray(parsed2.final_picks) ? parsed2.final_picks : [];
    log?.info("LLM2 cache HIT", { keyLLM2, picksCount: entries.length });
    sendDebug({ where: "llm2_cache_hit", picks: entries });
  } else {
    log?.info("LLM2 cache MISS -> calling OpenAI", { keyLLM2 });

    const messages2 = [
      { role: "system", content: "Return ONLY raw JSON. No prose. No code fences." },
      {
        role: "user",
        content: `
For each ingredient, choose up to ${Math.max(1, Math.min(2, chooseMax))} items by returning the indices.

Output format:
{"final_picks":[{"ingredient":"tomato","indices":[0,3]}]}

ingredients = ${JSON.stringify(ingList)}
candidates =
${JSON.stringify(enumerated, null, 2)}
        `.trim(),
      },
    ];

    const llm2Raw = await callGPT5JSON(messages2, {
      maxTokens: 1200,
      schema: {
        name: "final_picks_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            final_picks: {
              type: "array",
              minItems: ingList.length,
              maxItems: ingList.length,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  ingredient: { type: "string", enum: ingList },
                  indices: {
                    type: "array",
                    items: { type: "integer", minimum: 0 },
                    minItems: 0,
                    maxItems: Math.max(1, Math.min(2, chooseMax)),
                  },
                },
                required: ["ingredient", "indices"],
              },
            },
          },
          required: ["final_picks"],
        },
      },
    });

    const parsed2 = safeJSONParse(llm2Raw, { final_picks: [] });
    entries = Array.isArray(parsed2.final_picks) ? parsed2.final_picks : [];
    log?.info("LLM2 result", { picksCount: entries.length, rawPreview: safeShort(llm2Raw, 350) });
    sendDebug({ where: "llm2_result", picks: entries });

    await redis.set(
      keyLLM2,
      JSON.stringify({ final_picks: entries }),
      "EX",
      60 * 60 * 24 * 30
    );
  }

  const matchedInKrogerSet = new Set();
  const krogerMatchedByIngredient = {};
  const products = [];

  for (const { ingredient: ing, indices } of (entries || [])) {
    const pool = fullByIng[ing] || [];
    const titles = titlesByIng[ing] || [];
    const idx = Array.from(
      new Set((Array.isArray(indices) ? indices : []).filter(Number.isInteger))
    );

    if (!idx.length) continue;

    let matchedHere = 0;
    for (const i of idx) {
      if (i < 0 || i >= titles.length) continue;
      const title = titles[i];
      const hit = pool.find((p) => p.description === title) || pool[i];
      if (!hit) continue;

      const norm = normalizeKroger(hit, locationId);
      products.push(norm);
      (krogerMatchedByIngredient[ing] ||= []).push(norm);
      matchedHere++;
    }

    if (matchedHere > 0) matchedInKrogerSet.add(ing);
  }

  const krogerCandidateCounts = Object.fromEntries(
    ingList.map((ing) => [ing, (titlesByIng[ing] || []).length])
  );

  log?.info("Kroger pipeline result", {
    productsCount: products.length,
    matchedIngredientsCount: matchedInKrogerSet.size,
    warningsCount: warnings.length,
  });
  sendDebug({
    where: "kroger_pipeline_done",
    productsCount: products.length,
    matchedIngredients: Array.from(matchedInKrogerSet),
    warnings,
  });

  const resultPayload = {
    products,
    warnings,
    dishName: dishName || null,
    ingredients,
    matchedInKroger: Array.from(matchedInKrogerSet),
    krogerCandidateCounts,
    krogerMatchedByIngredient,
  };

  try {
    await redis.set(fastKey, JSON.stringify(resultPayload));
  } catch (e) {
    log?.warn("dishcache write failed", { err: e?.message || String(e) });
  }

  return resultPayload;
}

/* ===================== Walmart: LLM index-based matching ===================== */
function normTitle(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[®™]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function extractUnmatchedTerms(warnings = []) {
  const UNMATCH_CODES = new Set([
    "no_candidates",
    "product_search_failed",
    "no_confident_title",
    "no_valid_indices",
    "no_confident_match",
    "title_not_in_pool",
  ]);
  const terms = [];
  for (const w of warnings) {
    const ing = w?.ingredient && String(w.ingredient).trim();
    if (!ing) continue;
    if (w?.error && UNMATCH_CODES.has(w.error)) terms.push(ing);
  }
  return Array.from(new Set(terms.map((t) => t.toLowerCase()))).slice(0, 6);
}

async function runWalmartMatchByIndexDetailed(
  terms = [],
  { passCount = 20, chooseMax = 2, log, onDebug } = {}
) {
  const ingList = Array.from(new Set((terms || []).filter(Boolean)));
  if (!ingList.length) {
    log?.info("Walmart skipped (no terms)");
    return { products: [], matchedInWalmart: [], walmartCandidateCounts: {}, byIngredient: {} };
  }

  log?.info("Walmart matching start", { terms: ingList });
  onDebug?.({ where: "walmart_start", terms: ingList });

  const titlesByIng = {};
  const fullByIng = {};

  for (const ing of ingList) {
    try {
      const items = await walmartRawSearch(ing);
      fullByIng[ing] = items;
      titlesByIng[ing] = items.map((it) => it?.name || "").filter(Boolean).slice(0, passCount);
      log?.info("Walmart candidates", {
        ingredient: ing,
        candidates: titlesByIng[ing].length,
        top3: titlesByIng[ing].slice(0, 3),
      });
    } catch (e) {
      log?.error("Walmart search failed", { ingredient: ing, err: e?.message || String(e) });
      fullByIng[ing] = [];
      titlesByIng[ing] = [];
    }
  }

  const enumerated = {};
  for (const ing of ingList) enumerated[ing] = (titlesByIng[ing] || []).map((t, i) => `${i}: ${t}`);

  const messages = [
    { role: "system", content: "Return ONLY raw JSON. No prose. No code fences." },
    {
      role: "user",
      content: `
For each ingredient, choose up to ${Math.max(1, Math.min(2, chooseMax))} items by returning indices.

Output:
{"final_picks":[{"ingredient":"x","indices":[0]}]}

ingredients = ${JSON.stringify(ingList)}
candidates =
${JSON.stringify(enumerated, null, 2)}
      `.trim(),
    },
  ];

  const raw = await callGPT5JSON(messages, {
    maxTokens: 1200,
    schema: {
      name: "final_picks_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          final_picks: {
            type: "array",
            minItems: ingList.length,
            maxItems: ingList.length,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                ingredient: { type: "string", enum: ingList },
                indices: {
                  type: "array",
                  items: { type: "integer", minimum: 0 },
                  minItems: 0,
                  maxItems: Math.max(1, Math.min(2, chooseMax)),
                },
              },
              required: ["ingredient", "indices"],
            },
          },
        },
        required: ["final_picks"],
      },
    },
  });

  const parsed = safeJSONParse(raw, { final_picks: [] });
  const entries = (parsed?.final_picks || []).filter((e) => e && ingList.includes(e.ingredient));
  log?.info("Walmart LLM picks", { rawPreview: safeShort(raw, 350), picks: entries });
  onDebug?.({ where: "walmart_llm_picks", picks: entries });

  const out = [];
  const matchedSet = new Set();
  const byIngredient = {};

  for (const { ingredient: ing, indices } of entries) {
    const pool = fullByIng[ing] || [];
    const titles = titlesByIng[ing] || [];
    const idx = Array.from(
      new Set((Array.isArray(indices) ? indices : []).filter(Number.isInteger))
    );
    if (!idx.length) continue;

    const chosen = [];
    for (const i of idx) if (i >= 0 && i < titles.length) chosen.push(titles[i]);
    if (!chosen.length) continue;

    const byNorm = new Map(pool.map((it) => [normTitle(it?.name || ""), it]));
    let matchedHere = 0;

    for (const t of chosen) {
      const n = normTitle(t);
      const hit = pool.find((it) => (it?.name || "") === t) || byNorm.get(n);
      if (hit) {
        const norm = normalizeWalmart(hit);
        out.push(norm);
        (byIngredient[ing] ||= []).push(norm);
        matchedHere++;
      }
    }

    if (matchedHere > 0) matchedSet.add(ing);
  }

  const walmartCandidateCounts = Object.fromEntries(
    ingList.map((ing) => [ing, (titlesByIng[ing] || []).length])
  );

  log?.info("Walmart matching result", {
    productsCount: out.length,
    matchedIngredientsCount: matchedSet.size,
  });

  onDebug?.({
    where: "walmart_done",
    productsCount: out.length,
    matchedIngredients: Array.from(matchedSet),
  });

  return {
    products: out,
    matchedInWalmart: Array.from(matchedSet),
    walmartCandidateCounts,
    byIngredient,
  };
}

/* ===================== Build final payload ===================== */
function buildFinalPayload(krogerResult, walmartResult, { budgetSearch, log, onDebug } = {}) {
  const k = krogerResult || {};
  const w = walmartResult || {};
  const ingredients = Array.isArray(k.ingredients) ? k.ingredients : [];
  const krogerByIngredient = k.krogerMatchedByIngredient || {};
  const walmartByIngredient = w.byIngredient || {};

  if (!budgetSearch) {
    const krogerMatchedSet = new Set(k.matchedInKroger || []);
    const unmatchedIngredients = ingredients.filter((ing) => !krogerMatchedSet.has(ing));

    const payload = {
      budgetSearch: false,
      dishName: k.dishName || null,
      ingredients,
      krogerProducts: k.products || [],
      walmartProducts: w.products || [],
      matchedInKroger: k.matchedInKroger || [],
      matchedInWalmart: w.matchedInWalmart || [],
      krogerByIngredient,
      walmartByIngredient,
      unmatchedIngredients,
      unmatchedTerms: extractUnmatchedTerms(k.warnings || []),
      warnings: k.warnings || [],
    };

    log?.info("Final payload (non-budget)", {
      krogerProducts: payload.krogerProducts.length,
      walmartProducts: payload.walmartProducts.length,
      unmatchedIngredients: payload.unmatchedIngredients.length,
    });
    onDebug?.({
      where: "final_payload_non_budget",
      counts: {
        krogerProducts: payload.krogerProducts.length,
        walmartProducts: payload.walmartProducts.length,
      },
    });

    return payload;
  }

  // Budget mode comparison across retailers (per ingredient)
  const finalKrogerByIngredient = {};
  const finalWalmartByIngredient = {};
  const budgetDecisions = [];

  for (const ing of ingredients) {
    const kArr = Array.isArray(krogerByIngredient?.[ing]) ? krogerByIngredient[ing] : [];
    const wArr = Array.isArray(walmartByIngredient?.[ing]) ? walmartByIngredient[ing] : [];

    const decision = chooseWinnerForIngredient(kArr, wArr);

    if (decision.winner === "kroger") {
      if (kArr.length) finalKrogerByIngredient[ing] = kArr;
    } else if (decision.winner === "walmart") {
      if (wArr.length) finalWalmartByIngredient[ing] = wArr;
    }

    budgetDecisions.push({
      ingredient: ing,
      winner: decision.winner,
      reason: decision.reason,
      kroger: decision.krogerBest
        ? {
            price: decision.krogerBest.price,
            unitKind: decision.krogerBest.unitKind,
            unitQty: decision.krogerBest.unitQty,
            unitPrice: decision.krogerBest.unitPrice,
            title: decision.krogerBest.product?.title || "",
          }
        : null,
      walmart: decision.walmartBest
        ? {
            price: decision.walmartBest.price,
            unitKind: decision.walmartBest.unitKind,
            unitQty: decision.walmartBest.unitQty,
            unitPrice: decision.walmartBest.unitPrice,
            title: decision.walmartBest.product?.title || "",
          }
        : null,
    });
  }

  const finalKrogerProducts = [];
  for (const arr of Object.values(finalKrogerByIngredient)) for (const p of arr) finalKrogerProducts.push(p);

  const finalWalmartProducts = [];
  for (const arr of Object.values(finalWalmartByIngredient)) for (const p of arr) finalWalmartProducts.push(p);

  const matchedInKroger = Object.keys(finalKrogerByIngredient);
  const matchedInWalmart = Object.keys(finalWalmartByIngredient);

  const payload = {
    budgetSearch: true,
    dishName: k.dishName || null,
    ingredients,
    krogerProducts: finalKrogerProducts,
    walmartProducts: finalWalmartProducts,
    matchedInKroger,
    matchedInWalmart,
    krogerByIngredient: finalKrogerByIngredient,
    walmartByIngredient: finalWalmartByIngredient,
    unmatchedTerms: extractUnmatchedTerms(k.warnings || []),
    warnings: k.warnings || [],
    budgetDecisions, // debug-friendly
  };

  log?.info("Final payload (budget)", {
    krogerProducts: payload.krogerProducts.length,
    walmartProducts: payload.walmartProducts.length,
    matchedInKroger: payload.matchedInKroger.length,
    matchedInWalmart: payload.matchedInWalmart.length,
  });

  // Important debug: if BOTH lists are empty, show why
  if (!payload.krogerProducts.length && !payload.walmartProducts.length) {
    log?.warn("Budget payload is empty (no winners). Inspect decisions.", {
      decisionsPreview: budgetDecisions.slice(0, 10),
    });
  }

  onDebug?.({
    where: "final_payload_budget",
    counts: {
      krogerProducts: payload.krogerProducts.length,
      walmartProducts: payload.walmartProducts.length,
    },
    decisionsPreview: budgetDecisions.slice(0, 10),
  });

  return payload;
}

/* ===================== Cart Add Helpers ===================== */
const KROGER_BASE = process.env.KROGER_BASE_URL || "https://api.kroger.com/v1";
const KROGER_ID = process.env.KROGER_CLIENT_ID;
const KROGER_SECRET = process.env.KROGER_CLIENT_SECRET;
const KROGER_REDIRECT = process.env.KROGER_REDIRECT_URI;
const KROGER_SCOPES = process.env.KROGER_SCOPES || "cart.basic:write product.compact";
const APP_SECRET = process.env.JWT_SECRET || process.env.APP_SECRET || "dev-secret";

function b64u(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64uJson(obj) {
  return b64u(JSON.stringify(obj));
}
function signState(stateObj) {
  const body = b64uJson(stateObj);
  const sig = crypto
    .createHmac("sha256", APP_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}
function buildAuthorizeUrl(stateObj) {
  const state = signState(stateObj);
  const params = new URLSearchParams({
    scope: KROGER_SCOPES,
    response_type: "code",
    client_id: KROGER_ID,
    redirect_uri: KROGER_REDIRECT,
    state,
  });
  return `${KROGER_BASE}/connect/oauth2/authorize?${params.toString()}`;
}
function isTokenValid(kroger) {
  if (!kroger?.accessToken || !kroger?.expiresAt) return false;
  return new Date(kroger.expiresAt).getTime() - Date.now() > 60_000;
}
async function refreshWithRefreshToken(user) {
  if (!user?.kroger?.refreshToken) return null;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: user.kroger.refreshToken,
    scope: KROGER_SCOPES,
  });

  const auth = Buffer.from(`${KROGER_ID}:${KROGER_SECRET}`).toString("base64");
  const { data } = await axios.post(`${KROGER_BASE}/connect/oauth2/token`, form, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
  });

  user.kroger.accessToken = data.access_token;
  user.kroger.refreshToken = data.refresh_token || user.kroger.refreshToken;
  user.kroger.expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await user.save();

  return user.kroger.accessToken;
}
async function getValidUserToken(user) {
  if (isTokenValid(user?.kroger)) return user.kroger.accessToken;
  if (user?.kroger?.refreshToken) {
    try {
      return await refreshWithRefreshToken(user);
    } catch {}
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearCartSnapshotForUser(userId) {
  if (!userId) return;
  try {
    const u = await User.findById(userId);
    if (!u) return;
    u.kroger = u.kroger || {};
    u.kroger.cartSnapshot = new Map();
    await u.save();
  } catch {}
}

async function addKrogerItemsToCart({ user, itemsToAdd, returnTo, onCartEvent, log }) {
  const u = await User.findById(user._id);
  if (!u) return { ok: false, error: "user_not_found" };

  const items = (Array.isArray(itemsToAdd) ? itemsToAdd : [])
    .map((x) => ({
      upc: String(x?.upc || "").trim(),
      quantity: Number(x?.quantity || 1) || 1,
      ingredient: x?.ingredient || null,
      title: x?.title || null,
    }))
    .filter((x) => x.upc);

  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.upc)) continue;
    seen.add(it.upc);
    uniq.push(it);
  }

  log?.info("Cart add start", { total: uniq.length, returnTo });

  if (typeof onCartEvent === "function") onCartEvent({ type: "start", total: uniq.length });

  if (!uniq.length) {
    if (typeof onCartEvent === "function")
      onCartEvent({ type: "done", ok: true, addedCount: 0, total: 0, skippedCount: 0 });
    return { ok: true, addedCount: 0, skippedCount: 0, items: [] };
  }

  let token = await getValidUserToken(u);
  if (!token) {
    const loginUrl = buildAuthorizeUrl({
      userId: String(u._id),
      action: "add_to_cart",
      items: uniq.map((x) => ({ upc: x.upc, quantity: x.quantity })),
      returnTo: returnTo || "/",
      t: Date.now(),
    });
    log?.warn("Cart add needs Kroger OAuth", { loginUrl });
    return {
      ok: false,
      needKrogerAuth: true,
      loginUrl,
      addedCount: 0,
      skippedCount: 0,
      items: [],
    };
  }

  u.kroger = u.kroger || {};
  u.kroger.cartSnapshot = u.kroger.cartSnapshot || new Map();

  let addedCount = 0;
  const addedItems = [];

  for (let i = 0; i < uniq.length; i++) {
    const it = uniq[i];

    const attempt = async (bearer) => {
      return axios.put(
        `${KROGER_BASE}/cart/add`,
        { items: [{ upc: it.upc, quantity: it.quantity }] },
        {
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          validateStatus: () => true,
        }
      );
    };

    let resp = await attempt(token);

    if (resp.status === 401 || resp.status === 403) {
      const refreshed = await getValidUserToken(u);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        resp = await attempt(token);
      }
    }

    const ok = resp.status >= 200 && resp.status < 300;

    if (ok) {
      addedCount++;
      addedItems.push(it);
      u.kroger.cartSnapshot.set(it.upc, it.quantity);
    }

    log?.info("Cart add item", {
      ok,
      index: i,
      total: uniq.length,
      upc: it.upc,
      status: resp.status,
    });

    if (typeof onCartEvent === "function") {
      onCartEvent({
        type: "item",
        ok,
        upc: it.upc,
        quantity: it.quantity,
        ingredient: it.ingredient || null,
        title: it.title || null,
        index: i,
        total: uniq.length,
        addedCount,
        status: ok ? null : resp.status,
      });
    }

    await sleep(220);
  }

  await u.save();

  if (typeof onCartEvent === "function") {
    onCartEvent({ type: "done", ok: true, addedCount, total: uniq.length, skippedCount: 0 });
  }

  log?.info("Cart add done", { addedCount, total: uniq.length });

  return { ok: true, addedCount, skippedCount: 0, items: addedItems };
}

/* ===================== LangGraph runners (kept) ===================== */
const budgetSearchRunner = buildBudgetSearchGraphRunner({
  runKrogerSearchPipeline,
  runWalmartMatchByIndexDetailed,
  buildFinalPayload,
});

const agenticRunner = buildAgenticSearchGraphRunner({
  runKrogerSearchPipeline,
  runWalmartMatchByIndexDetailed,
  buildFinalPayload,
  addAllKrogerItemsToCart: async () => ({ ok: false, error: "disabled_in_stream_mode" }),
});

/* ============================ FRIDGE UPLOAD ============================ */
export async function krogerFridgeUpload(req, res) {
  const requestId = crypto.randomBytes(6).toString("hex");
  const log = mkLogger(requestId, { route: "krogerFridgeUpload" });

  try {
    log.info("Fridge upload start", { userId: req.user?._id || null });

    if (!req.user?._id) {
      return res.status(401).json({ error: "Login required to use fridge photo feature." });
    }

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: "No image uploaded." });
    }

    const sha = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const cacheKey = `vision:fridge:v1:${sha}`;

    let items = null;
    const cached = await redis.get(cacheKey);
    if (cached) {
      items = JSON.parse(cached);
      log.info("Fridge vision cache HIT", { cacheKey, itemsCount: items?.length || 0 });
    } else {
      log.info("Fridge vision cache MISS -> calling OpenAI", { cacheKey });

      const mime = file.mimetype || "image/jpeg";
      const b64 = file.buffer.toString("base64");
      const dataUrl = `data:${mime};base64,${b64}`;

      items = await callGPT5VisionFridgeItems({ imageDataUrl: dataUrl });

      const cleaned = Array.from(new Set(items.map((x) => normText(x)).filter(Boolean))).slice(0, 30);
      items = cleaned;

      await redis.set(cacheKey, JSON.stringify(items), "EX", 60 * 60 * 24 * 30);
      log.info("Fridge vision stored", { itemsCount: items.length, top: items.slice(0, 10) });
    }

    const fridgeSessionId = crypto.randomBytes(12).toString("hex");
    await redis.set(`fridge:${fridgeSessionId}`, JSON.stringify({ items }), "EX", 60 * 30);

    log.info("Fridge session created", { fridgeSessionId, itemsCount: items.length });
    return res.json({ fridgeSessionId, items });
  } catch (e) {
    log.error("Fridge upload failed", { err: e?.response?.data || e?.message || e });
    return res.status(500).json({ error: "Failed to analyze fridge photo." });
  }
}

/* ============================ HTTP Controllers ============================ */

// JSON route
export async function krogerSearch(req, res) {
  const requestId = crypto.randomBytes(6).toString("hex");
  const log = mkLogger(requestId, { route: "krogerSearch" });

  try {
    const { query, zip, budgetSearch, autoAdd } = req.body || {};
    const budget = Boolean(budgetSearch);
    const doAutoAdd = Boolean(autoAdd);
    const returnTo = req.get("referer") || "/";

    log.info("JSON search request", { query, zip, budget, autoAdd: doAutoAdd, userId: req.user?._id || null });

    if (doAutoAdd) {
      await clearCartSnapshotForUser(req.user?._id);

      const krogerResult = await runKrogerSearchPipeline({
        query,
        zip,
        user: req.user,
        passCount: 20,
        chooseMax: 2,
        onPhase: null,
        onDebug: null,
        log,
      });

      const walmartTerms = budget
        ? (krogerResult.ingredients || [])
        : extractUnmatchedTerms(krogerResult?.warnings || []);

      log.info("Walmart terms decided", { budget, walmartTerms });

      const walmartResult = await runWalmartMatchByIndexDetailed(walmartTerms, {
        passCount: 20,
        chooseMax: 2,
        log,
      });

      const payload = buildFinalPayload(krogerResult, walmartResult, { budgetSearch: budget, log });

      const plan = (payload?.krogerProducts || [])
        .map((p) => ({ upc: p.upc, quantity: 1 }))
        .filter((x) => x.upc);

      log.info("AutoAdd plan built (JSON route)", { planCount: plan.length });

      const cartAdd = await addKrogerItemsToCart({
        user: req.user,
        itemsToAdd: plan,
        returnTo,
        onCartEvent: null,
        log,
      });

      return res.json({ ...payload, autoAdd: true, cartAdd });
    }

    if (budget) {
      // Keep as-is (graph runner), but log inputs/outputs
      const result = await budgetSearchRunner.invoke({
        query,
        zip,
        user: req.user,
        budgetSearch: true,
        passCount: 20,
        chooseMaxKroger: 2,
        chooseMaxWalmart: 2,
        onPhase: null,
      });

      log.info("Budget graph runner result", {
        hasPayload: Boolean(result?.payload),
        krogerProducts: result?.payload?.krogerProducts?.length || 0,
        walmartProducts: result?.payload?.walmartProducts?.length || 0,
      });

      return res.json({ ...(result?.payload || {}) });
    }

    const krogerResult = await runKrogerSearchPipeline({
      query,
      zip,
      user: req.user,
      passCount: 20,
      chooseMax: 2,
      onPhase: null,
      onDebug: null,
      log,
    });

    const walmartTerms = extractUnmatchedTerms(krogerResult?.warnings || []);
    log.info("Walmart terms decided (non-budget)", { walmartTerms });

    const walmartResult = await runWalmartMatchByIndexDetailed(walmartTerms, {
      passCount: 20,
      chooseMax: 2,
      log,
    });

    const payload = buildFinalPayload(krogerResult, walmartResult, { budgetSearch: false, log });
    return res.json(payload);
  } catch (e) {
    log.error("JSON search failed", { err: e?.response?.data || e?.message || e });
    res.status(500).json({ error: "Search failed" });
  }
}

// STREAMING (SSE): search+match only, returns cartSessionId
export async function krogerSearchStream(req, res) {
  const requestId = crypto.randomBytes(6).toString("hex");
  const log = mkLogger(requestId, { route: "krogerSearchStream" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const query = req.query.query || "";
  const zip = req.query.zip || undefined;
  const budget = req.query.budget === "1" || req.query.budget === "true";
  const autoAdd = req.query.autoAdd === "1" || req.query.autoAdd === "true";
  const fridgeSid = String(req.query.fridgeSid || "").trim() || null;

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onPhase = (phase) => {
    send("phase", { phase });
    log.info("SSE phase", { phase });
  };

  const onDebug = (obj) => {
    if (!DEBUG) return;
    // Push debug events into stream too (optional)
    send("debug", { requestId, ...obj });
  };

  log.info("SSE search request", {
    query,
    zip,
    budget,
    autoAdd,
    fridgeSid,
    userId: req.user?._id || null,
  });

  try {
    const krogerResult = await runKrogerSearchPipeline({
      query,
      zip,
      user: req.user,
      passCount: 20,
      chooseMax: 2,
      onPhase,
      onDebug,
      log,
    });

    const walmartTerms = budget
      ? (krogerResult.ingredients || [])
      : extractUnmatchedTerms(krogerResult?.warnings || []);

    onPhase("walmart");
    log.info("Walmart terms decided (SSE)", { budget, walmartTerms });

    const walmartResult = await runWalmartMatchByIndexDetailed(walmartTerms, {
      passCount: 20,
      chooseMax: 2,
      log,
      onDebug,
    });

    onPhase("selecting");

    const payload = buildFinalPayload(krogerResult, walmartResult, {
      budgetSearch: budget,
      log,
      onDebug,
    });

    log.info("SSE payload counts", {
      krogerProducts: payload?.krogerProducts?.length || 0,
      walmartProducts: payload?.walmartProducts?.length || 0,
    });

    let cartSessionId = null;

    if (autoAdd) {
      if (!req.user?._id) {
        send("done", { ...payload, autoAdd: false, error: "Login required for auto-add." });
        return res.end();
      }

      await clearCartSnapshotForUser(req.user?._id);

      const plan = [];
      const byIng = payload?.krogerByIngredient || {};
      for (const [ingredient, arr] of Object.entries(byIng)) {
        const p = Array.isArray(arr) ? arr[0] : null;
        if (!p?.upc) continue;
        plan.push({
          upc: p.upc,
          quantity: 1,
          ingredient,
          title: p.title || "",
        });
      }

      cartSessionId = crypto.randomBytes(12).toString("hex");

      await redis.set(
        `cartplan:${cartSessionId}`,
        JSON.stringify({
          items: plan,
          fridgeSid,
          returnTo: req.get("referer") || "/",
        }),
        "EX",
        60 * 10
      );

      log.info("Cartplan stored", { cartSessionId, planCount: plan.length, fridgeSid });
      onDebug({ where: "cartplan", cartSessionId, planCount: plan.length, fridgeSid });
    }

    send("done", {
      ...payload,
      autoAdd: Boolean(autoAdd),
      cartSessionId,
    });

    return res.end();
  } catch (e) {
    log.error("SSE search failed", { err: e?.response?.data || e?.message || e });
    send("done", { error: "Search failed", requestId });
    return res.end();
  }
}

/**
 * SSE cart add stream:
 * Filters plan using fridgeSid (if present).
 */
export async function krogerCartAddStream(req, res) {
  const requestId = crypto.randomBytes(6).toString("hex");
  const log = mkLogger(requestId, { route: "krogerCartAddStream" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sid = String(req.query.sid || "").trim();
  const user = req.user;

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!user?._id) {
    log.warn("Cart add stream unauthenticated");
    send("done", { ok: false, error: "not_authenticated" });
    return res.end();
  }
  if (!sid) {
    log.warn("Cart add stream missing sid");
    send("done", { ok: false, error: "missing_sid" });
    return res.end();
  }

  log.info("Cart add stream start", { sid, userId: user._id });

  try {
    const raw = await redis.get(`cartplan:${sid}`);
    if (!raw) {
      log.warn("Cartplan missing/expired", { sid });
      send("done", { ok: false, error: "invalid_or_expired_sid" });
      return res.end();
    }

    const plan = JSON.parse(raw);
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const returnTo = plan?.returnTo || "/";
    const fridgeSid = plan?.fridgeSid || null;

    log.info("Cartplan loaded", { itemsCount: items.length, returnTo, fridgeSid });

    let fridgeItems = [];
    if (fridgeSid) {
      const fr = await redis.get(`fridge:${fridgeSid}`);
      if (fr) {
        const parsed = JSON.parse(fr);
        fridgeItems = Array.isArray(parsed?.items) ? parsed.items : [];
      }
      log.info("Fridge session loaded", { fridgeSid, fridgeItemsCount: fridgeItems.length });
    }

    const finalItems = [];
    let skippedCount = 0;

    for (const it of items) {
      const ingredient = it?.ingredient || "";
      const title = it?.title || "";

      if (fridgeItems.length && looksLikeCovered(fridgeItems, ingredient, title)) {
        skippedCount++;
        send("cart_item_skipped", {
          upc: it.upc,
          ingredient,
          title,
          reason: "already_in_fridge",
          skippedCount,
        });
        continue;
      }

      finalItems.push(it);
    }

    log.info("Cartplan after fridge filtering", {
      original: items.length,
      final: finalItems.length,
      skippedCount,
    });

    const onCartEvent = (evt) => {
      if (!evt || typeof evt !== "object") return;

      if (evt.type === "start") {
        send("cart_add_start", { total: evt.total ?? 0, skippedCount });
      } else if (evt.type === "item") {
        send("cart_item_added", {
          ok: Boolean(evt.ok),
          upc: evt.upc || "",
          quantity: Number(evt.quantity || 1),
          index: Number(evt.index || 0),
          total: Number(evt.total || 0),
          addedCount: Number(evt.addedCount || 0),
          status: evt.status ?? null,
        });
      } else if (evt.type === "done") {
        send("cart_add_done", {
          ok: Boolean(evt.ok),
          addedCount: Number(evt.addedCount || 0),
          total: Number(evt.total || 0),
          skippedCount,
        });
      }
    };

    const result = await addKrogerItemsToCart({
      user,
      itemsToAdd: finalItems,
      returnTo,
      onCartEvent,
      log,
    });

    if (result?.needKrogerAuth && result?.loginUrl) {
      log.warn("Need Kroger OAuth during cart add", { loginUrl: result.loginUrl });
      send("need_kroger_auth", { loginUrl: result.loginUrl });
      send("done", { ok: false, needKrogerAuth: true, loginUrl: result.loginUrl });
      return res.end();
    }

    send("done", {
      ok: Boolean(result?.ok),
      addedCount: result?.addedCount || 0,
      skippedCount,
    });
    return res.end();
  } catch (e) {
    log.error("Cart add stream failed", { err: e?.response?.data || e?.message || e });
    send("done", { ok: false, error: "cart_add_failed", requestId });
    return res.end();
  }
}

export async function krogerTestEval(req, res) {
  res.json({ ok: true });
}
