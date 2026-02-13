// config/walmartAffiliate.js (ESM)
// Adds Redis caching to rawSearch() + extended debug logging (WM_DEBUG=1)

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { redis } from './redis.js';

const BASE_URL =
  process.env.WM_API_BASE_URL ||
  'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';

const WM_CONSUMER_ID = process.env.WM_CONSUMER_ID || '';
const WM_KEY_VERSION = (process.env.WM_KEY_VERSION || '1').toString();
const KEY_PATH = process.env.WM_PRIVATE_KEY_PATH || '';
const PASSPHRASE = process.env.WM_PRIVATE_KEY_PASSPHRASE || undefined;

const WM_DEBUG = process.env.WM_DEBUG === '1' || process.env.WM_DEBUG === 'true';

function debug(...args) {
  if (WM_DEBUG) console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function errlog(...args) {
  console.error(...args);
}

if (!WM_CONSUMER_ID) warn('[WALMART] WM_CONSUMER_ID is not set.');
if (!KEY_PATH) warn('[WALMART] WM_PRIVATE_KEY_PATH is not set.');

debug('[WALMART DEBUG] Boot config', {
  BASE_URL,
  WM_CONSUMER_ID: WM_CONSUMER_ID ? `${WM_CONSUMER_ID.slice(0, 8)}...` : '',
  WM_KEY_VERSION,
  KEY_PATH,
  HAS_PASSPHRASE: Boolean(PASSPHRASE),
});

// Lazily parsed key
let PRIVATE_KEY_OBJ = null;
let PRIVATE_KEY_META = null;

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

/**
 * Returns a stable "fingerprint" of the key's modulus.
 * This is safe to log and helps confirm you are using the key you think you are.
 */
function keyModulusFingerprintHex(keyObj) {
  try {
    const jwk = keyObj.export({ format: 'jwk' });
    // For RSA, modulus is jwk.n (base64url). Hash it.
    if (jwk && jwk.kty === 'RSA' && jwk.n) return sha256Hex(jwk.n);
  } catch {}
  return null;
}

function getPrivateKey() {
  if (PRIVATE_KEY_OBJ) return PRIVATE_KEY_OBJ;
  if (!KEY_PATH) throw new Error('WM_PRIVATE_KEY_PATH not configured');

  const resolved = path.isAbsolute(KEY_PATH) ? KEY_PATH : path.resolve(process.cwd(), KEY_PATH);

  debug('[WALMART DEBUG] Resolving private key path', {
    KEY_PATH,
    resolved,
    cwd: process.cwd(),
    exists: fs.existsSync(resolved),
  });

  const pem = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');

  try {
    PRIVATE_KEY_OBJ = crypto.createPrivateKey({
      key: pem,
      format: 'pem',
      passphrase: PASSPHRASE,
    });

    const meta = {
      type: PRIVATE_KEY_OBJ.type, // 'private'
      asymmetricKeyType: PRIVATE_KEY_OBJ.asymmetricKeyType, // 'rsa'
      modulusFingerprint: keyModulusFingerprintHex(PRIVATE_KEY_OBJ),
      pemSha256: WM_DEBUG ? sha256Hex(pem) : undefined, // file content hash (safe, but only in debug)
    };

    PRIVATE_KEY_META = meta;

    debug('[WALMART DEBUG] Private key parsed OK', meta);
    return PRIVATE_KEY_OBJ;
  } catch (e) {
    errlog(
      `[WALMART] Failed to parse private key at ${resolved}. ` +
        'If encrypted, set WM_PRIVATE_KEY_PASSPHRASE; otherwise convert to unencrypted PKCS#8:\n' +
        '  openssl pkcs8 -topk8 -nocrypt -in in.pem -out out.pem'
    );
    throw e;
  }
}

/**
 * Sign base string:
 *   consumerId + '\n' + timestampMs + '\n' + keyVersion
 */
function sign(tsMs) {
  const base = `${WM_CONSUMER_ID}\n${tsMs}\n${WM_KEY_VERSION}\n`;

  debug('[WALMART DEBUG] Signature base', {
    basePreview: WM_DEBUG ? base : undefined,
    baseLen: base.length,
    tsMs,
    WM_KEY_VERSION,
    keyMeta: PRIVATE_KEY_META || null,
  });

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(base, 'utf8');
  signer.end();

  const sigB64 = signer.sign(getPrivateKey()).toString('base64');

  debug('[WALMART DEBUG] Signature generated', {
    sigLen: sigB64.length,
    sigPrefix: sigB64.slice(0, 12), // do NOT print whole signature
  });

  return sigB64;
}

export function getWalmartHeaders() {
  const ts = Date.now().toString();

  // Generate signature (may throw if key missing/bad)
  const signature = sign(ts);

  const headers = {
    'WM_CONSUMER.ID': WM_CONSUMER_ID,
    'WM_CONSUMER.INTIMESTAMP': ts,
    'WM_SEC.KEY_VERSION': WM_KEY_VERSION,
    'WM_SEC.AUTH_SIGNATURE': signature,
    Accept: 'application/json',
  };

  debug('[WALMART DEBUG] Request headers (redacted)', {
    'WM_CONSUMER.ID': headers['WM_CONSUMER.ID'],
    'WM_CONSUMER.INTIMESTAMP': headers['WM_CONSUMER.INTIMESTAMP'],
    'WM_SEC.KEY_VERSION': headers['WM_SEC.KEY_VERSION'],
    // redact signature
    'WM_SEC.AUTH_SIGNATURE': `${signature.slice(0, 12)}...(${signature.length})`,
    Accept: headers.Accept,
  });

  return headers;
}

/* ----------------------------- HTTP helper ----------------------------- */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}

function safePickHeaders(h = {}) {
  // pick a few headers that are useful for debugging without noise
  const out = {};
  const wanted = [
    'content-type',
    'date',
    'x-request-id',
    'wm_qos.correlation_id',
    'wmqoscorrelationid',
    'x-correlation-id',
  ];
  for (const k of wanted) {
    const v = h?.[k] || h?.[k.toLowerCase()];
    if (v) out[k] = v;
  }
  return out;
}

export async function rawSearch(term) {
  if (!WM_CONSUMER_ID || !KEY_PATH) {
    debug('[WALMART DEBUG] rawSearch skipped (missing WM_CONSUMER_ID or KEY_PATH)', {
      hasConsumer: Boolean(WM_CONSUMER_ID),
      hasKeyPath: Boolean(KEY_PATH),
    });
    return [];
  }

  const cacheKey = `wm:search:v1:q=${norm(term)}`;

  try {
    const hit = await redis.get(cacheKey);
    if (hit) {
      debug('[WALMART DEBUG] Cache HIT', { term, cacheKey, bytes: hit.length });
      return JSON.parse(hit);
    }
    debug('[WALMART DEBUG] Cache MISS', { term, cacheKey });
  } catch (e) {
    // cache failures shouldn't break search
    warn('[WALMART] Redis cache error (continuing without cache):', e?.message || e);
  }

  const url = `${BASE_URL}/search?query=${encodeURIComponent(term)}`;

  debug('[WALMART DEBUG] HTTP GET', { url, timeoutMs: 10000 });

  try {
    const { data } = await axios.get(url, { headers: getWalmartHeaders(), timeout: 10000 });

    debug('[WALMART DEBUG] HTTP OK', {
      term,
      url,
      topLevelKeys: data ? Object.keys(data).slice(0, 15) : [],
      itemsType: typeof data?.items,
      itemsLen: Array.isArray(data?.items) ? data.items.length : 0,
    });

    const items = Array.isArray(data?.items) ? data.items : [];

    // cache positive results
    try {
      await redis.set(cacheKey, JSON.stringify(items), 'EX', 60 * 60 * 12); // 12h
      debug('[WALMART DEBUG] Cache SET (positive)', { cacheKey, count: items.length });
    } catch (e) {
      warn('[WALMART] Redis cache set error (positive):', e?.message || e);
    }

    return items;
  } catch (e) {
    const status = e?.response?.status;
    const respData = e?.response?.data;

    warn('[Walmart] search error:', term, status || e?.message);

    // ✅ Print the response body to understand why 401
    if (WM_DEBUG) {
      debug('[WALMART DEBUG] Error details', {
        term,
        url,
        status,
        responseHeaders: safePickHeaders(e?.response?.headers || {}),
        responseData: respData || null,
        axiosMessage: e?.message,
      });
    }

    // cache negative results briefly (prevents hammering)
    try {
      await redis.set(cacheKey, JSON.stringify([]), 'EX', 60 * 10);
      debug('[WALMART DEBUG] Cache SET (negative)', { cacheKey, ttlSec: 600 });
    } catch (cacheErr) {
      warn('[WALMART] Redis cache set error (negative):', cacheErr?.message || cacheErr);
    }

    return [];
  }
}

/* -------------------------- List-free ranking -------------------------- */
function normalizeStr(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return new Set(normalizeStr(s).split(' ').filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const uni = aSet.size + bSet.size - inter;
  return inter / uni;
}

function scoreItem(item, term) {
  const name = item?.name || '';
  const cat = item?.categoryPath || '';
  const upc = item?.upc || '';
  const price = typeof item?.salePrice === 'number' ? item.salePrice : null;

  const termT = tokens(term);
  const nameT = tokens(name);
  const catT = tokens(cat);

  const nameSim = jaccard(termT, nameT);
  const catSim = jaccard(termT, catT);

  let score = 0;
  score += Math.round(nameSim * 100);
  score += Math.round(catSim * 40);
  if (upc && /^\d{8,14}$/.test(upc)) score += 8;
  if (price !== null) score += 5;
  if (/\b(ground|whole|pure|organic|unflavored|plain)\b/.test(normalizeStr(name))) score += 2;

  return score;
}

function pickTop(items, term, limit = 2) {
  const scored = items
    .map((it) => ({ it, s: scoreItem(it, term) }))
    .sort((a, b) => b.s - a.s);

  const top = scored.slice(0, Math.max(0, Math.min(limit, 2))).map((x) => x.it);

  top.sort((a, b) => {
    const pa = typeof a?.salePrice === 'number' ? a.salePrice : Number.POSITIVE_INFINITY;
    const pb = typeof b?.salePrice === 'number' ? b.salePrice : Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  return top;
}

/* ----------------------------- Normalizer ------------------------------ */
export function normalize(item) {
  return {
    _id: `wm_${item?.itemId ?? item?.upc ?? crypto.randomUUID()}`,
    title: item?.name || 'Product',
    imageUrl: item?.mediumImage || item?.largeImage || item?.thumbnailImage || '',
    price:
      typeof item?.salePrice === 'number'
        ? item.salePrice
        : typeof item?.msrp === 'number'
        ? item.msrp
        : 0,
    upc: item?.upc || '',
    retailer: 'walmart',
    url: (item?.productTrackingUrl || item?.productUrl || '').toString(),
    raw: item,
  };
}

/* ------------------------------ Public API ----------------------------- */
export async function searchByTerm(term, { perTermLimit = 2 } = {}) {
  const items = await rawSearch(term);
  return pickTop(items, term, perTermLimit).map(normalize);
}

export async function searchUnmatched(terms = [], { perTermLimit = 2 } = {}) {
  const uniq = Array.from(new Set((terms || []).filter(Boolean)));
  if (!uniq.length) return [];

  const perTerm = await Promise.all(
    uniq.map(async (t) => pickTop(await rawSearch(t), t, perTermLimit).map(normalize))
  );

  const out = [];
  const seen = new Set();
  for (const arr of perTerm) {
    for (const n of arr) {
      const key = (n.upc && `u:${n.upc}`) || `t:${normalizeStr(n.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

export default { getWalmartHeaders, searchByTerm, searchUnmatched, rawSearch, normalize };