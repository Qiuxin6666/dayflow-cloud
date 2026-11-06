/* DayFlow Cloud bootstrap: Supabase auth + a small fetch adapter that lets the
   existing local-first UI talk to a per-user `planner_state` row. */
(() => {
  "use strict";

  const cfg = window.DAYFLOW_CONFIG || {};
  const overlay = document.getElementById("cloudLogin");
  const form = document.getElementById("cloudAuthForm");
  const emailInput = document.getElementById("cloudEmail");
  const passwordInput = document.getElementById("cloudPassword");
  const password2Wrap = document.getElementById("cloudPassword2Wrap");
  const password2Input = document.getElementById("cloudPassword2");
  const submit = document.getElementById("cloudAuthSubmit");
  const signupToggle = document.getElementById("cloudSignupToggle");
  const message = document.getElementById("cloudAuthMessage");

  let client = null;
  let user = null;
  let signupMode = false;
  let authResolved = false;
  let resolveAuth;
  const authReady = new Promise((resolve) => { resolveAuth = resolve; });
  const originalFetch = window.fetch.bind(window);
  let lastRemoteUpdatedAt = "";

  function setMessage(text, kind = "") {
    if (!message) return;
    message.textContent = text || "";
    message.dataset.kind = kind;
  }

  function showLogin(show = true) {
    if (!overlay) return;
    overlay.hidden = !show;
    document.body.style.overflow = show ? "hidden" : "";
    if (show) setTimeout(() => emailInput?.focus(), 80);
  }

  function markAuthenticated(session) {
    if (!session?.user) return;
    user = session.user;
    showLogin(false);
    if (!authResolved) {
      authResolved = true;
      resolveAuth();
    }
  }

  function setupAuthUi() {
    if (cfg.allowSignup === false && signupToggle) signupToggle.hidden = true;
    signupToggle?.addEventListener("click", () => {
      signupMode = !signupMode;
      password2Wrap.hidden = !signupMode;
      password2Input.required = signupMode;
      submit.textContent = signupMode ? "创建账号" : "登录";
      signupToggle.textContent = signupMode ? "已有账号？返回登录" : "第一次使用？创建账号";
      passwordInput.autocomplete = signupMode ? "new-password" : "current-password";
      setMessage("");
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!client) return;
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || password.length < 6) {
        setMessage("请输入邮箱，密码至少 6 位。", "error");
        return;
      }
      if (signupMode && password !== password2Input.value) {
        setMessage("两次输入的密码不一致。", "error");
        return;
      }
      submit.disabled = true;
      submit.textContent = signupMode ? "创建中…" : "登录中…";
      setMessage("");
      try {
        if (signupMode) {
          const { data, error } = await client.auth.signUp({ email, password });
          if (error) throw error;
          if (data.session) {
            markAuthenticated(data.session);
          } else {
            setMessage("账号已创建。请打开邮箱点击确认链接，然后回来登录。", "ok");
            signupMode = false;
            password2Wrap.hidden = true;
            submit.textContent = "登录";
          }
        } else {
          const { data, error } = await client.auth.signInWithPassword({ email, password });
          if (error) throw error;
          markAuthenticated(data.session);
        }
      } catch (error) {
        setMessage(error.message || "登录失败，请稍后重试。", "error");
      } finally {
        submit.disabled = false;
        if (!user) submit.textContent = signupMode ? "创建账号" : "登录";
      }
    });
  }

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  function emptyState() {
    return {
      version: 2,
      tasks: [],
      settings: {},
      meta: {
        seeded: false,
        demo: false,
        revision: 0,
        notified: [],
        events: [],
        createdAt: new Date().toISOString()
      }
    };
  }

  async function loadRow() {
    if (!client || !user) throw new Error("not signed in");
    const { data, error } = await client
      .from(cfg.table || "planner_state")
      .select("state,updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      if (error.code === "42P01") {
        setMessage("数据库还没有初始化：请先在 Supabase SQL Editor 运行 schema.sql。", "error");
        showLogin(true);
      }
      throw error;
    }
    if (data) {
      lastRemoteUpdatedAt = data.updated_at || "";
      return data;
    }
    const initial = emptyState();
    const now = new Date().toISOString();
    const { error: insertError } = await client
      .from(cfg.table || "planner_state")
      .insert({ user_id: user.id, state: initial, updated_at: now });
    if (insertError) throw insertError;
    lastRemoteUpdatedAt = now;
    return { state: initial, updated_at: now };
  }

  async function saveRow(state) {
    const now = new Date().toISOString();
    const { error } = await client
      .from(cfg.table || "planner_state")
      .upsert({ user_id: user.id, state, updated_at: now }, { onConflict: "user_id" });
    if (error) throw error;
    lastRemoteUpdatedAt = now;
    return now;
  }

  async function callCloudFunction(path, body) {
    const { data, error } = await client.functions.invoke(path, { body });
    if (error) throw error;
    return data;
  }

  async function handleApi(input, init) {
    await authReady;
    if (!user) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const path = url.pathname;
    const method = (init.method || "GET").toUpperCase();

    if (path === "/api/health") {
      return jsonResponse({ ok: true, app: "DayFlow", mode: "cloud", now: new Date().toISOString() });
    }

    if (path === "/api/state" && method === "GET") {
      try {
        const row = await loadRow();
        return jsonResponse({ ok: true, state: row.state, savedAt: row.updated_at });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || "cloud state unavailable" }, 503);
      }
    }

    if (path === "/api/state" && method === "PUT") {
      try {
        const payload = JSON.parse(init.body || "{}");
        const savedAt = await saveRow(payload.state);
        return jsonResponse({ ok: true, savedAt, revision: 0 });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || "cloud save failed" }, 503);
      }
    }

    if (path === "/api/meta") {
      let row = null;
      try { row = await loadRow(); } catch { /* report the connection anyway */ }
      const webhook = row?.state?.settings?.webhook || {};
      return jsonResponse({
        ok: true,
        app: "DayFlow",
        mode: "cloud",
        version: 1,
        now: new Date().toISOString(),
        startedAt: "",
        userEmail: user.email,
        webhookConfigured: Boolean(webhook.enabled && webhook.url),
        webhookType: webhook.type || "auto",
        lanEnabled: false,
        lanUrl: "",
        localUrl: location.origin,
        autostart: false,
        dataFile: "Supabase · planner_state",
        appUrl: location.origin,
        supabaseUrl: cfg.supabaseUrl
      });
    }

    if (path === "/api/events") {
      try {
        const row = await loadRow();
        const since = Number(new URL(url.href).searchParams.get("since") || 0);
        const events = (row.state?.meta?.events || []).filter((event) => Number(event.id || 0) > since);
        return jsonResponse({ ok: true, events, now: new Date().toISOString() });
      } catch {
        return jsonResponse({ ok: true, events: [], now: new Date().toISOString() });
      }
    }

    if (path === "/api/notifications/test") {
      try {
        const { data, error } = await client.rpc("dayflow_test_push");
        if (error) throw error;
        return jsonResponse({ ok: Boolean(data?.ok), result: data || { ok: false } });
      } catch (error) {
        return jsonResponse({
          ok: false,
          result: {
            ok: false,
            reason: error.message || "云端提醒测试失败。请确认已运行 sql-reminders.sql 并配置企业微信 Webhook。"
          }
        });
      }
    }

    if (path === "/api/notifications/clear") {
      try {
        const row = await loadRow();
        const next = JSON.parse(JSON.stringify(row.state || emptyState()));
        next.meta = next.meta || {};
        next.meta.events = [];
        await saveRow(next);
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ ok: false }, 500);
      }
    }

    if (path === "/api/autostart") {
      return jsonResponse({ ok: true, enabled: false, path: "cloud" });
    }

    if (path === "/api/shutdown") {
      return jsonResponse({ ok: false, error: "cloud service" }, 400);
    }

    return jsonResponse({ ok: false, error: "not found" }, 404);
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!rawUrl) return originalFetch(input, init);
    let parsed;
    try { parsed = new URL(rawUrl, location.href); } catch { return originalFetch(input, init); }
    if (parsed.origin !== location.origin || !parsed.pathname.startsWith("/api/")) {
      return originalFetch(input, init);
    }
    return handleApi(input, init);
  };

  async function start() {
    if (!window.supabase?.createClient) {
      setMessage("Supabase 客户端加载失败，请刷新页面。", "error");
      showLogin(true);
      return;
    }
    if (!cfg.supabaseUrl || !cfg.supabaseKey) {
      setMessage("缺少 config.js 中的 Supabase URL 或 Publishable Key。", "error");
      showLogin(true);
      return;
    }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    window.DAYFLOW_SUPABASE = client;
    window.DAYFLOW_SIGN_OUT = async () => {
      await client.auth.signOut();
      location.reload();
    };
    setupAuthUi();

    const { data } = await client.auth.getSession();
    if (data?.session) markAuthenticated(data.session);

    client.auth.onAuthStateChange((_event, session) => {
      if (session) markAuthenticated(session);
      else if (authResolved) {
        user = null;
        setMessage("登录状态已失效，请重新登录。", "error");
        showLogin(true);
      }
    });

    if (!data?.session) showLogin(true);

    // Sign out control in the cloud account card (the settings page is static).
    const card = document.getElementById("serverDetail")?.closest(".setting-card");
    if (card) {
      const button = document.createElement("button");
      button.className = "btn btn--ghost cloud-signout";
      button.type = "button";
      button.textContent = "退出当前账号";
      button.addEventListener("click", async () => {
        await client.auth.signOut();
        location.reload();
      });
      card.appendChild(button);
    }
  }

  start().catch((error) => {
    setMessage(error.message || "云端初始化失败。", "error");
    showLogin(true);
  });
})();
