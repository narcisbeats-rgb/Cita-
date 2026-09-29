import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { createTelnyxVerifiedNumbers, normalizeE164, providerHasVerifiedNumber, requireOwnerVerifiedCaller } from "./caller-identity.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "__Host-traducere_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export function createCallerAccounts(app, {
  env = process.env, PoolImpl = pg.Pool, fetchImpl = fetch, now = () => Date.now()
} = {}) {
  const wanted = env.PUBLIC_CALLER_ACCOUNTS_ENABLED === "true";
  const configured = wanted && Boolean(env.DATABASE_URL) &&
    typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32 &&
    typeof env.SIGNUP_INVITE_CODE === "string" && env.SIGNUP_INVITE_CODE.length >= 24 &&
    Boolean(env.TELNYX_API_KEY);
  const pool = configured ? new PoolImpl({
    connectionString: env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 10000,
    ...(env.PG_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
  }) : null;
  const provider = configured ? createTelnyxVerifiedNumbers({ apiKey: env.TELNYX_API_KEY, fetchImpl }) : null;
  const throttle = new Map();
  let ready = false;

  function allow(key, limit, windowMs = ATTEMPT_WINDOW_MS) {
    const t = now();
    if (throttle.size > 3000) for (const [k, v] of throttle) if (v.expires <= t) throttle.delete(k);
    const prev = throttle.get(key);
    const state = prev && prev.expires > t ? prev : { count: 0, expires: t + windowMs };
    state.count++;
    throttle.set(key, state);
    return state.count <= limit;
  }
  function json(res, status, error) { return res.status(status).json({ error }); }
  function active(req, res, next) {
    res.set("Cache-Control", "no-store");
    if (!ready) return json(res, 503, "Conturile individuale nu sunt configurate.");
    next();
  }
  function safeOrigin(req, res, next) {
    const origin = req.get("origin");
    const site = req.get("sec-fetch-site");
    if (site === "cross-site" || (origin && origin !== env.PUBLIC_BASE_URL)) return json(res, 403, "Origin neautorizat.");
    if (!req.is("application/json")) return json(res, 415, "Folosește application/json.");
    next();
  }
  async function hashPassword(password, salt) {
    return (await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })).toString("base64");
  }
  function tokenHash(token) { return crypto.createHash("sha256").update(env.SESSION_SECRET + ":" + token).digest("hex"); }
  function cookieToken(req) {
    const match = String(req.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + "="));
    return match?.slice(SESSION_COOKIE.length + 1) || "";
  }
  function setCookie(res, token, maxAge = SESSION_SECONDS) {
    res.set("Set-Cookie", SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge);
  }
  async function getUser(req) {
    if (!ready) return null;
    const token = cookieToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const r = await pool.query(
      "SELECT u.id,u.email FROM caller_sessions s JOIN caller_users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW()",
      [tokenHash(token)]
    );
    return r.rows[0] || null;
  }
  async function authenticated(req, res, next) {
    try {
      const user = await getUser(req);
      if (!user) return json(res, 401, "Autentifică-te pentru a folosi numărul propriu.");
      req.callerUser = user;
      next();
    } catch { json(res, 503, "Contul nu poate fi verificat momentan."); }
  }
  async function createSession(res, user) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO caller_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",
      [tokenHash(token), user.id]
    );
    setCookie(res, token);
    return { authenticated: true, email: user.email };
  }
  async function init() {
    if (!configured) {
      if (wanted) console.error("Public accounts are disabled: DATABASE_URL, SESSION_SECRET, SIGNUP_INVITE_CODE or TELNYX_API_KEY missing/weak.");
      return;
    }
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS caller_users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS caller_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES caller_users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS caller_sessions_expires_idx ON caller_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS caller_numbers (
          user_id TEXT PRIMARY KEY REFERENCES caller_users(id) ON DELETE CASCADE,
          phone_number TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          verification_started_at TIMESTAMPTZ,
          verification_window TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          verification_attempts INTEGER NOT NULL DEFAULT 0,
          code_attempts INTEGER NOT NULL DEFAULT 0,
          verified_at TIMESTAMPTZ
        );
      `);
      ready = true;
    } catch (e) {
      ready = false;
      console.error("Caller account database unavailable:", e.message);
    }
  }

  app.get("/api/account/availability", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ enabled: ready, beta: true });
  });

  app.post("/api/account/register", active, safeOrigin, async (req, res) => {
    const ip = req.ip || "unknown";
    if (!allow("register:" + ip, 5, 60 * 60 * 1000)) return json(res, 429, "Prea multe încercări.");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    const invite = req.body?.invite;
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || typeof password !== "string" || password.length < 12 || password.length > 128) {
      return json(res, 400, "Email invalid sau parolă mai scurtă de 12 caractere.");
    }
    if (typeof invite !== "string" ||
      !crypto.timingSafeEqual(crypto.createHash("sha256").update(invite).digest(), crypto.createHash("sha256").update(env.SIGNUP_INVITE_CODE).digest())) {
      return json(res, 403, "Invitație invalidă.");
    }
    try {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = await hashPassword(password, salt);
      const user = { id: crypto.randomUUID(), email };
      await pool.query("INSERT INTO caller_users(id,email,password_salt,password_hash) VALUES($1,$2,$3,$4)", [user.id, email, salt, hash]);
      res.status(201).json(await createSession(res, user));
    } catch (e) {
      if (e.code === "23505") return json(res, 409, "Contul există deja.");
      json(res, 503, "Nu am putut crea contul.");
    }
  });

  app.post("/api/account/login", active, safeOrigin, async (req, res) => {
    const ip = req.ip || "unknown";
    if (!allow("login:" + ip, 10)) return json(res, 429, "Prea multe încercări de autentificare.");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    if (email.length > 255 || typeof password !== "string" || password.length > 128) return json(res, 401, "Date de autentificare incorecte.");
    try {
      const rows = await pool.query("SELECT id,email,password_salt,password_hash FROM caller_users WHERE email=$1", [email]);
      const user = rows.rows[0];
      const salt = user?.password_salt || "aabbccddeeff00112233445566778899";
      const check = Buffer.from(await hashPassword(password, salt), "base64");
      const actual = user ? Buffer.from(user.password_hash, "base64") : crypto.randomBytes(64);
      if (!user || actual.length !== check.length || !crypto.timingSafeEqual(actual, check)) return json(res, 401, "Date de autentificare incorecte.");
      res.json(await createSession(res, user));
    } catch { json(res, 503, "Autentificarea este indisponibilă momentan."); }
  });

  app.post("/api/account/logout", active, safeOrigin, async (req, res) => {
    try {
      const token = cookieToken(req);
      if (token) await pool.query("DELETE FROM caller_sessions WHERE token_hash=$1", [tokenHash(token)]);
      setCookie(res, "", 0);
      res.json({ ok: true });
    } catch { json(res, 503, "Nu am putut închide sesiunea."); }
  });

  app.get("/api/account/me", active, async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.json({ authenticated: false });
      const r = await pool.query("SELECT phone_number,status,verified_at FROM caller_numbers WHERE user_id=$1", [user.id]);
      const number = r.rows[0];
      res.json({ authenticated: true, email: user.email,
        callerId: number?.phone_number || null, verificationStatus: number?.status || "none" });
    } catch { json(res, 503, "Profilul nu poate fi verificat momentan."); }
  });

  // The code/voice verification is explicitly chargeable and only initiated by an authenticated user.
  app.post("/api/account/number/start", active, safeOrigin, authenticated, async (req, res) => {
    const number = normalizeE164(req.body?.phoneNumber);
    const method = ["sms", "call"].includes(req.body?.method) ? req.body.method : "sms";
    if (!number || req.body?.verificationConsent !== true) return json(res, 400, "Introdu un număr E.164 și confirmă costurile verificării.");
    const userId = req.callerUser.id;
    if (!allow("verify:" + userId, 3, 24 * 60 * 60 * 1000)) return json(res, 429, "Limita de verificări a fost atinsă.");
    const client = await pool.connect().catch(() => null);
    if (!client) return json(res, 503, "Baza de date indisponibilă.");
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT * FROM caller_numbers WHERE user_id=$1 FOR UPDATE", [userId]);
      const row = existing.rows[0];
      if (row?.phone_number === number && row.status === "verified") {
        await client.query("ROLLBACK");
        return json(res, 409, "Numărul este deja verificat.");
      }
      const sameWindow = row && (now() - new Date(row.verification_window).getTime() < 24 * 60 * 60 * 1000);
      const count = sameWindow ? row.verification_attempts : 0;
      if (count >= 3) { await client.query("ROLLBACK"); return json(res, 429, "Reîncearcă mâine."); }
      await client.query(`INSERT INTO caller_numbers(user_id,phone_number,status,verification_started_at,verification_window,verification_attempts,code_attempts,verified_at)
        VALUES($1,$2,'pending',NOW(),NOW(),1,0,NULL)
        ON CONFLICT(user_id) DO UPDATE SET phone_number=$2,status='pending',verification_started_at=NOW(),
          verification_window=CASE WHEN caller_numbers.verification_window>NOW()-INTERVAL '24 hours' THEN caller_numbers.verification_window ELSE NOW() END,
          verification_attempts=CASE WHEN caller_numbers.verification_window>NOW()-INTERVAL '24 hours' THEN caller_numbers.verification_attempts+1 ELSE 1 END,
          code_attempts=0,verified_at=NULL`, [userId, number]);
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      if (e.code === "23505") return json(res, 409, "Numărul este deja asociat altui cont.");
      return json(res, 503, "Numărul nu a putut fi rezervat.");
    } finally { client.release(); }
    try {
      await provider.start(number, method);
      res.status(202).json({ status: "pending", phoneNumber: number, method, message: "Introdu codul primit de la Telnyx." });
    } catch { json(res, 502, "Telnyx nu a acceptat solicitarea. O nouă încercare poate genera costuri."); }
  });

  app.post("/api/account/number/confirm", active, safeOrigin, authenticated, async (req, res) => {
    const userId = req.callerUser.id;
    const code = req.body?.verificationCode;
    if (typeof code !== "string" || !/^\d{4,8}$/.test(code)) return json(res, 400, "Cod invalid.");
    if (!allow("code:" + userId, 7)) return json(res, 429, "Prea multe coduri încercate.");
    try {
      const changed = await pool.query(`UPDATE caller_numbers SET code_attempts=code_attempts+1
        WHERE user_id=$1 AND status='pending' AND verification_started_at>NOW()-INTERVAL '20 minutes'
        AND code_attempts<5 RETURNING phone_number`, [userId]);
      const number = changed.rows[0]?.phone_number;
      if (!number) return json(res, 409, "Nu există o verificare activă pentru cont.");
      const result = await provider.submit(number, code);
      const fresh = await provider.lookup(number);
      if (!providerHasVerifiedNumber(result, number) || !providerHasVerifiedNumber(fresh, number)) {
        return json(res, 409, "Numărul nu este încă verificat de Telnyx.");
      }
      await pool.query(`UPDATE caller_numbers SET status='verified',verified_at=$3
        WHERE user_id=$1 AND phone_number=$2 AND status='pending'`, [userId, number, fresh.data.verified_at]);
      res.json({ verified: true, phoneNumber: number });
    } catch { json(res, 409, "Codul nu a fost confirmat. Verifică-l și reîncearcă."); }
  });

  app.post("/api/account/number/refresh", active, safeOrigin, authenticated, async (req, res) => {
    try {
      const userId = req.callerUser.id;
      const row = (await pool.query("SELECT * FROM caller_numbers WHERE user_id=$1", [userId])).rows[0];
      if (!row || row.status !== "verified") return json(res, 409, "Numărul nu este verificat.");
      const verified = providerHasVerifiedNumber(await provider.lookup(row.phone_number), row.phone_number);
      if (!verified) await pool.query("UPDATE caller_numbers SET status='revoked',verified_at=NULL WHERE user_id=$1 AND phone_number=$2", [userId, row.phone_number]);
      res.json({ phoneNumber: row.phone_number, verified });
    } catch { json(res, 503, "Statusul Telnyx nu poate fi confirmat."); }
  });

  async function resolveCaller(req) {
    if (!ready) return { status: 503, error: "Conturile individuale nu sunt configurate. Apelul nu a fost inițiat." };
    if (Object.hasOwn(req.body || {}, "from")) return { status: 400, error: "Numărul de origine se selectează exclusiv din profilul verificat." };
    let user;
    try { user = await getUser(req); } catch { return { status: 503, error: "Sesiunea nu a putut fi verificată." }; }
    if (!user) return { status: 401, error: "Autentifică-te înainte de a suna." };
    try {
      const row = (await pool.query("SELECT * FROM caller_numbers WHERE user_id=$1", [user.id])).rows[0];
      const number = await requireOwnerVerifiedCaller({ ownerId: user.id, numberRecord: row, providerLookup: number => provider.lookup(number) });
      if (!number) {
        if (row?.status === "verified") {
          await pool.query("UPDATE caller_numbers SET status='revoked',verified_at=NULL WHERE user_id=$1 AND phone_number=$2", [user.id, row.phone_number]);
        }
        return { status: 409, error: "Verifică numărul propriu în cont înainte de a suna." };
      }
      return { number, userId: user.id };
    } catch {
      return { status: 503, error: "Nu am putut confirma numărul la Telnyx. Apelul nu a fost inițiat." };
    }
  }
  return { get enabled() { return ready; }, init, getUser, resolveCaller };
}
