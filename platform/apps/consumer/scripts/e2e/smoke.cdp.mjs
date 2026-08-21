#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const E2E_BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";
const E2E_API_BASE = process.env.E2E_API_BASE || "http://127.0.0.1:8001/api/v1";
const E2E_HEALTH_URL = process.env.E2E_HEALTH_URL || "http://127.0.0.1:8001/health";
const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL || "e2e.smoke@example.com";
const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD || "PickketE2E!2026";
const E2E_USER_NAME = process.env.E2E_USER_NAME || "E2E Smoke";
const E2E_ORGANIZER_EMAIL = process.env.E2E_ORGANIZER_EMAIL || "";
const E2E_ORGANIZER_PASSWORD = process.env.E2E_ORGANIZER_PASSWORD || process.env.E2E_SEED_PASSWORD || "pickket2026!";
const E2E_CHROME_BIN = process.env.E2E_CHROME_BIN || "google-chrome";
const E2E_DEBUG_PORT = Number(process.env.E2E_CHROME_DEBUG_PORT || "9333");
const DEFAULT_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || "90000");
const SEEDED_ORGANIZER_EMAILS = [
  "organizer@cjenm.com",
  "organizer@hyundaicard.com",
  "organizer@interpark.com",
];

function log(message) {
  console.log(`[smoke] ${message}`);
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

async function waitFor(description, fn, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 500) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const suffix = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`Timeout while waiting for ${description}${suffix}`);
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const onOpen = () => {
        this.ws = ws;
        resolve();
      };
      const onError = (error) => reject(error);
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("message", (event) => {
        this.#onMessage(event.data);
      });
      ws.addEventListener("close", () => {
        for (const [, pending] of this.pending) {
          pending.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  #onMessage(raw) {
    const payload = JSON.parse(raw);

    if (payload.id) {
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || "CDP command failed"));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (!payload.method) return;
    const listeners = this.eventListeners.get(payload.method) || [];
    for (const listener of listeners) {
      listener(payload.params || {});
    }
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP websocket is not open");
    }

    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    const resultPromise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(message);
    return resultPromise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.text || "Runtime.evaluate failed";
      throw new Error(detail);
    }
    return result.result ? result.result.value : null;
  }

  async waitForEvent(method, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for event ${method}`));
      }, timeoutMs);

      const listener = (params) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      };

      const unsubscribe = () => {
        const listeners = this.eventListeners.get(method) || [];
        this.eventListeners.set(
          method,
          listeners.filter((item) => item !== listener),
        );
      };

      const listeners = this.eventListeners.get(method) || [];
      listeners.push(listener);
      this.eventListeners.set(method, listeners);
    });
  }

  on(method, listener) {
    const listeners = this.eventListeners.get(method) || [];
    listeners.push(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      const current = this.eventListeners.get(method) || [];
      this.eventListeners.set(
        method,
        current.filter((item) => item !== listener),
      );
    };
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitForEvent("Page.loadEventFired", DEFAULT_TIMEOUT_MS);
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

async function ensureHealth() {
  await waitFor("backend health endpoint", async () => {
    const response = await fetch(E2E_HEALTH_URL);
    return response.ok;
  }, 60000, 1000);
}

async function loginViaApi(email, password) {
  const response = await fetch(`${E2E_API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return response;
}

async function registerViaApi(email, password, name) {
  const payload = {
    email,
    password,
    name,
    is_organizer: false,
    consents: {
      terms: true,
      privacy: true,
      age14: true,
      marketing: false,
      marketing_channels: {
        email: false,
        sms: false,
        push: false,
      },
      third_party: false,
      consented_at: new Date().toISOString(),
    },
  };

  return fetch(`${E2E_API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function ensureTestUser() {
  const loginResponse = await loginViaApi(E2E_USER_EMAIL, E2E_USER_PASSWORD);
  if (loginResponse.ok) {
    log(`using existing test account: ${E2E_USER_EMAIL}`);
    return;
  }

  log(`test account not found, registering: ${E2E_USER_EMAIL}`);
  const registerResponse = await registerViaApi(E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_USER_NAME);
  if (!registerResponse.ok && registerResponse.status !== 400 && registerResponse.status !== 409) {
    const body = await parseJsonSafe(registerResponse);
    throw new Error(`failed to register test user (status ${registerResponse.status}): ${JSON.stringify(body)}`);
  }

  const reloginResponse = await loginViaApi(E2E_USER_EMAIL, E2E_USER_PASSWORD);
  if (!reloginResponse.ok) {
    const body = await parseJsonSafe(reloginResponse);
    throw new Error(`failed to login test user after register (status ${reloginResponse.status}): ${JSON.stringify(body)}`);
  }
}

async function ensureOrganizerToken() {
  const emails = [];
  if (E2E_ORGANIZER_EMAIL) emails.push(E2E_ORGANIZER_EMAIL);
  for (const email of SEEDED_ORGANIZER_EMAILS) {
    if (!emails.includes(email)) emails.push(email);
  }

  let lastFailure = "unknown organizer auth failure";
  for (const email of emails) {
    const response = await loginViaApi(email, E2E_ORGANIZER_PASSWORD);
    const body = await parseJsonSafe(response);
    if (!response.ok) {
      lastFailure = `${email}: login status ${response.status}`;
      continue;
    }

    const token = body?.access_token;
    if (!token) {
      lastFailure = `${email}: missing access token`;
      continue;
    }
    if (!body?.user?.is_organizer) {
      lastFailure = `${email}: account is not organizer`;
      continue;
    }

    log(`using organizer account: ${email}`);
    return token;
  }

  throw new Error(
    `unable to authenticate organizer for fallback provisioning (${lastFailure})`,
  );
}

function normalizedStatus(status) {
  return String(status || "").toLowerCase();
}

function scoreCandidate(event, tier, preferredModes) {
  const mode = String(tier.sale_mode || "");
  let score = 0;
  if (normalizedStatus(event.status) === "bidding_open") score += 100;
  if (mode === preferredModes[0]) score += 25;
  if (mode === preferredModes[1]) score += 15;
  if (tier.seating_type !== "assigned") score += 10;
  score += Math.min(Number(tier.remaining || 0), 100) / 10;
  return score;
}

async function getJsonArray(url) {
  const response = await fetch(url);
  if (!response.ok) return [];
  const data = await parseJsonSafe(response);
  return extractJsonArray(data);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function provisionSmokeEventAndTier() {
  const organizerToken = await ensureOrganizerToken();
  const now = Date.now();
  const eventOpensAt = new Date(now - 60 * 60 * 1000).toISOString();
  const eventClosesAt = new Date(now + 72 * 60 * 60 * 1000).toISOString();
  const eventDate = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const eventPayload = {
    title: `E2E Smoke Event ${nonce}`,
    description: "Automated E2E smoke event",
    venue: "E2E Test Hall",
    event_date: eventDate,
    bidding_opens_at: eventOpensAt,
    bidding_closes_at: eventClosesAt,
    total_seats: 500,
    min_price: 99000,
    max_price: 199000,
    category: "CONCERT",
    location_city: "Seoul",
    artist_name: "E2E Test Artist",
  };

  const createEventResponse = await fetch(`${E2E_API_BASE}/events/`, {
    method: "POST",
    headers: authHeaders(organizerToken),
    body: JSON.stringify(eventPayload),
  });
  const event = await parseJsonSafe(createEventResponse);
  if (!createEventResponse.ok || !event?.id) {
    throw new Error(
      `failed to provision event (status ${createEventResponse.status}): ${JSON.stringify(event)}`,
    );
  }

  const patchEventResponse = await fetch(`${E2E_API_BASE}/events/${event.id}`, {
    method: "PATCH",
    headers: authHeaders(organizerToken),
    body: JSON.stringify({ status: "bidding_open" }),
  });
  if (!patchEventResponse.ok) {
    const patchBody = await parseJsonSafe(patchEventResponse);
    log(
      `warning: failed to patch event status to bidding_open (status ${patchEventResponse.status}): ${JSON.stringify(patchBody)}`,
    );
  }

  const tierPayload = {
    name: "E2E FCFS Tier",
    capacity: 200,
    base_price: 99000,
    sale_mode: "fixed_fcfs",
    face_price: 99000,
    min_price: 99000,
    max_price_cap: 199000,
    allow_group_tickets: true,
    max_group_size: 4,
    bidding_opens_at: eventOpensAt,
    bidding_closes_at: eventClosesAt,
  };
  const createTierResponse = await fetch(`${E2E_API_BASE}/events/${event.id}/tiers`, {
    method: "POST",
    headers: authHeaders(organizerToken),
    body: JSON.stringify(tierPayload),
  });
  const tier = await parseJsonSafe(createTierResponse);
  if (!createTierResponse.ok || !tier?.id) {
    throw new Error(
      `failed to provision tier (status ${createTierResponse.status}): ${JSON.stringify(tier)}`,
    );
  }

  const remaining = Number(tier.remaining ?? tier.capacity ?? 0);
  log(`provisioned fallback event ${event.id} with tier ${tier.id}`);
  return { event, tier: { ...tier, remaining } };
}

async function findPurchasableEventAndTier() {
  const eventUrls = [
    `${E2E_API_BASE}/events/search?status=bidding_open&limit=60`,
    `${E2E_API_BASE}/events/search?limit=60`,
    `${E2E_API_BASE}/events?limit=60`,
  ];

  let events = [];
  for (const url of eventUrls) {
    events = await getJsonArray(url);
    if (events.length > 0) break;
  }

  if (events.length === 0) {
    log("no events found from API, provisioning fallback event/tier");
    return provisionSmokeEventAndTier();
  }

  const preferredModes = ["fixed_fcfs", "lottery"];
  const fallbackModes = ["fixed_fcfs", "lottery", "fanclub"];

  const collectCandidates = async (allowedModes) => {
    const candidates = [];
    for (const event of events) {
      if (!event?.id) continue;
      const tiers = await getJsonArray(`${E2E_API_BASE}/events/${event.id}/tiers`);
      for (const tier of tiers) {
        const mode = String(tier.sale_mode || "");
        const remaining = Number(tier.remaining || 0);
        const unitPrice = Number(tier.face_price ?? tier.base_price ?? 0);
        if (!allowedModes.includes(mode)) continue;
        if (remaining <= 0) continue;
        if (unitPrice <= 0) continue;
        if (mode === "fanclub_presale") continue;
        candidates.push({
          event,
          tier,
          score: scoreCandidate(event, tier, preferredModes),
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  };

  let candidates = await collectCandidates(preferredModes);
  if (candidates.length === 0) {
    candidates = await collectCandidates(fallbackModes);
  }
  if (candidates.length === 0) {
    log("no purchasable tier found from existing data, provisioning fallback event/tier");
    return provisionSmokeEventAndTier();
  }

  const picked = candidates[0];
  log(
    `picked event "${picked.event.title}" (${picked.event.id}) / tier "${picked.tier.name}" mode=${picked.tier.sale_mode} seating=${picked.tier.seating_type}`,
  );
  return picked;
}

async function startChrome(userDataDir) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${E2E_DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];

  const chrome = spawn(E2E_CHROME_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", () => {});
  chrome.stdout.on("data", () => {});

  await waitFor("chrome devtools endpoint", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${E2E_DEBUG_PORT}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, 20000, 300);

  const targetsResponse = await fetch(`http://127.0.0.1:${E2E_DEBUG_PORT}/json/list`);
  if (!targetsResponse.ok) {
    throw new Error("failed to query chrome targets");
  }
  const targets = await targetsResponse.json();
  const pageTarget = Array.isArray(targets)
    ? targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
    : null;

  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error("chrome page websocket target not found");
  }

  return { chrome, wsUrl: pageTarget.webSocketDebuggerUrl };
}

async function saveFailureScreenshot(client) {
  try {
    const outputDir = path.resolve("e2e-artifacts");
    await mkdir(outputDir, { recursive: true });
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const outputPath = path.join(outputDir, "smoke-failure.png");
    await writeFile(outputPath, Buffer.from(result.data, "base64"));
    log(`failure screenshot saved: ${outputPath}`);
  } catch (error) {
    log(`failed to save screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function performUiSmoke(client, candidate) {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Network.enable");
  await client.send("Network.clearBrowserCookies");
  await client.send("Network.clearBrowserCache");

  const browserErrors = [];
  const networkErrors = [];
  const pushBrowserError = (msg) => {
    if (!msg) return;
    if (browserErrors.length < 20) {
      browserErrors.push(String(msg).slice(0, 300));
    }
  };
  const pushNetworkError = (msg) => {
    if (!msg) return;
    if (networkErrors.length < 20) {
      networkErrors.push(String(msg).slice(0, 400));
    }
  };

  client.on("Runtime.exceptionThrown", (params) => {
    const text = params?.exceptionDetails?.exception?.description
      || params?.exceptionDetails?.text
      || "unknown runtime exception";
    pushBrowserError(`runtime exception: ${text}`);
  });

  client.on("Runtime.consoleAPICalled", (params) => {
    if (params?.type !== "error") return;
    const args = Array.isArray(params?.args) ? params.args : [];
    const joined = args
      .map((arg) => arg?.value || arg?.description || "")
      .filter(Boolean)
      .join(" ");
    pushBrowserError(`console error: ${joined || "unknown console error"}`);
  });

  client.on("Log.entryAdded", (params) => {
    if (!params?.entry) return;
    const level = String(params.entry.level || "");
    if (level !== "error" && level !== "warning") return;
    pushBrowserError(`browser log ${level}: ${params.entry.text || ""}`);
  });

  client.on("Network.responseReceived", (params) => {
    const status = Number(params?.response?.status || 0);
    if (status < 400) return;
    const url = params?.response?.url || "";
    pushNetworkError(`${status} ${url}`);
  });

  log("navigating to auth page");
  await client.navigate(`${E2E_BASE_URL}/auth`);

  await waitFor("login form inputs", async () => {
    const state = await client.evaluate(`(() => {
      const ready = Boolean(document.querySelector("#email") && document.querySelector("#password"));
      const text = (document.body?.innerText || "").slice(0, 240);
      return { ready, text };
    })()`);
    if (state?.text?.includes("Application error: a client-side exception")) {
      const hint = browserErrors[0] || "no browser error detail";
      throw new Error(`frontend crashed while loading /auth (${hint})`);
    }
    return Boolean(state?.ready);
  });

  await client.evaluate(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);

  const loginFormState = await client.evaluate(`(() => {
    const emailInput = document.querySelector("#email");
    const passwordInput = document.querySelector("#password");
    const form = emailInput?.closest("form");
    if (emailInput) emailInput.value = "";
    if (passwordInput) passwordInput.value = "";
    return {
      emailFound: Boolean(emailInput),
      passwordFound: Boolean(passwordInput),
      formFound: Boolean(form),
    };
  })()`);
  if (!loginFormState?.emailFound || !loginFormState?.passwordFound || !loginFormState?.formFound) {
    throw new Error("login form fields not found");
  }

  await client.evaluate(`document.querySelector("#email")?.focus(); true;`);
  await client.send("Input.insertText", { text: E2E_USER_EMAIL });
  await sleep(80);
  await client.evaluate(`document.querySelector("#password")?.focus(); true;`);
  await client.send("Input.insertText", { text: E2E_USER_PASSWORD });
  await sleep(80);

  const loginResult = await client.evaluate(`(() => {
    const textOf = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
    const form = document.querySelector("#email")?.closest("form");
    const submit = form?.querySelector('button[type="submit"]');
    if (form?.requestSubmit) {
      form.requestSubmit();
    } else if (submit) {
      submit.click();
    }
    const emailValue = document.querySelector("#email")?.value || "";
    const passwordValue = document.querySelector("#password")?.value || "";
    return {
      clicked: Boolean(submit),
      formFound: Boolean(form),
      emailMatches: emailValue === ${JSON.stringify(E2E_USER_EMAIL)},
      passwordLength: passwordValue.length,
      submitLabel: textOf(submit),
    };
  })()`);
  log(`login form submit state: ${JSON.stringify(loginResult)}`);

  if (!loginResult?.clicked || !loginResult?.formFound || !loginResult?.emailMatches || loginResult?.passwordLength <= 0) {
    throw new Error("failed to fill or submit login form");
  }

  await waitFor("redirect to /events after login", async () => {
    const state = await client.evaluate(`(() => {
      const pathname = location.pathname;
      const text = (document.body?.innerText || "");
      const hasLoginError =
        text.includes("Invalid credentials")
        || text.includes("잠깐 문제가 생겼어요")
        || text.includes("다시 시도해주세요");
      const hasCrashError = text.includes("Application error: a client-side exception");
      return { pathname, hasLoginError, hasCrashError };
    })()`);
    if (state?.hasLoginError) {
      throw new Error("login failed on UI");
    }
    if (state?.hasCrashError) {
      const hint = browserErrors[0] || "no browser error detail";
      const networkHint = networkErrors[0] ? `; ${networkErrors[0]}` : "";
      throw new Error(`frontend crashed after login submit (${hint}${networkHint})`);
    }
    return typeof state?.pathname === "string" && state.pathname.startsWith("/events");
  }, 30000, 500);

  log("login success, navigating to selected event");
  await client.navigate(`${E2E_BASE_URL}/events/${candidate.event.id}`);

  await waitFor("event page render", async () => {
    return client.evaluate(`Boolean(document.querySelector("body"))`);
  }, 30000, 500);

  const tierName = candidate.tier.name;
  log(`driving booking flow to pre-payment modal (tier=${tierName})`);

  let reachedOrderModal = false;
  for (let i = 0; i < 40; i += 1) {
    const state = await client.evaluate(`(() => {
      const textOf = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
      const findButtonByText = (text) =>
        Array.from(document.querySelectorAll("button")).find((btn) => !btn.disabled && textOf(btn).includes(text));

      const orderDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
        .find((dialog) => textOf(dialog).includes("주문서 확인"));
      if (orderDialog) {
        return { done: true, action: "order-modal-visible" };
      }

      const sessionHeading = Array.from(document.querySelectorAll("h2"))
        .find((h) => textOf(h).includes("회차 선택"));
      if (sessionHeading) {
        const section = sessionHeading.closest("section") || document;
        const sessionButton = Array.from(section.querySelectorAll("button"))
          .find((btn) => !btn.disabled && !textOf(btn).includes("매진"));
        if (sessionButton) {
          sessionButton.click();
          return { done: false, action: "session-selected" };
        }
      }

      const tierSection = document.querySelector("[data-tier-selector]");
      if (tierSection) {
        const tierCards = Array.from(tierSection.querySelectorAll('[role="button"]'));
        const tierByName = tierCards.find((card) => {
          const txt = textOf(card);
          return txt.includes(${JSON.stringify(tierName)}) && !txt.includes("매진");
        });
        const firstAvailableTier = tierCards.find((card) => !textOf(card).includes("매진"));
        const tierTarget = tierByName || firstAvailableTier;
        if (tierTarget) {
          tierTarget.click();
          return { done: false, action: "tier-selected" };
        }
      }

      const bestAvailableButton = findButtonByText("최적 좌석 자동 선택");
      if (bestAvailableButton) {
        bestAvailableButton.click();
        return { done: false, action: "best-seats-selected" };
      }

      const buyNowButton = findButtonByText("바로 구매하기");
      if (buyNowButton) {
        buyNowButton.click();
        return { done: false, action: "buy-now-clicked" };
      }

      const bidSubmitButton = findButtonByText("입찰하기");
      if (bidSubmitButton) {
        bidSubmitButton.click();
        return { done: false, action: "bid-submitted" };
      }

      const bidConfirmButton = findButtonByText("확인 후 결제");
      if (bidConfirmButton) {
        bidConfirmButton.click();
        return { done: false, action: "bid-confirmed" };
      }

      const nextButton = Array.from(document.querySelectorAll("button"))
        .find((btn) => {
          if (btn.disabled) return false;
          const text = textOf(btn);
          return text === "다음" || text === "결제하기";
        });
      if (nextButton) {
        const label = textOf(nextButton);
        nextButton.click();
        return { done: false, action: "nav-" + label };
      }

      return { done: false, action: "waiting" };
    })()`);

    if (state?.done) {
      reachedOrderModal = true;
      log(`flow action=${state.action}`);
      break;
    }

    if (state?.action && state.action !== "waiting") {
      log(`flow action=${state.action}`);
    }
    await sleep(900);
  }

  if (!reachedOrderModal) {
    const pathname = await client.evaluate("location.pathname");
    throw new Error(`failed to reach order confirmation modal (current path: ${pathname})`);
  }
}

async function main() {
  const profileDir = await mkdtemp(path.join(tmpdir(), "pickket-e2e-"));
  let chromeProcess = null;
  let client = null;

  try {
    log(`baseUrl=${E2E_BASE_URL}`);
    log(`apiBase=${E2E_API_BASE}`);
    await ensureHealth();
    await ensureTestUser();
    const candidate = await findPurchasableEventAndTier();

    const chromeSetup = await startChrome(profileDir);
    chromeProcess = chromeSetup.chrome;
    client = new CDPClient(chromeSetup.wsUrl);
    await client.connect();

    await performUiSmoke(client, candidate);

    log("PASS: login -> event -> pre-payment modal flow");
  } catch (error) {
    if (client) {
      await saveFailureScreenshot(client);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[smoke] FAIL: ${message}`);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
    }
    if (chromeProcess && !chromeProcess.killed) {
      chromeProcess.kill("SIGTERM");
      await sleep(300);
      if (!chromeProcess.killed) {
        chromeProcess.kill("SIGKILL");
      }
    }
    await rm(profileDir, { recursive: true, force: true });
  }
}

await main();
