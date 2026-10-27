// The live line: talk (or type) to a company's receptionist inside the page, and watch what it does.
// Uses the ElevenLabs browser SDK; the business's facts travel as dynamic variables (see actions/lib/demo.mjs).
const SDK = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm";
const STEPS = {
  check_availability: ["Checking the calendar", "Found open arrival windows"],
  book_appointment: ["Booking the visit", "Visit booked"],
  take_message: ["Saving a message for the team", "Message saved, team alerted"],
  find_booking: ["Looking up the booking", "Booking found"],
  change_booking: ["Changing the booking", "Booking changed"],
  end_call: ["Ending the call", "Call ended"],
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function mountLine(root, { agentId, vars, company, meta, prompts = [] }) {
  root.classList.add("line");
  root.dataset.state = "idle";
  root.innerHTML = `
  <div class="line-in">
    <div class="line-side">
      <div class="line-label">Incoming line</div>
      <div><div class="line-co">${esc(company)}</div><div class="line-meta" style="margin-top:8px">${meta}</div></div>
      <div class="line-status" aria-live="polite"><i></i><span data-status>Line open. Answers on the first ring.</span></div>
      <button class="callbtn" data-call type="button"><span class="ph" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg></span><span data-calllabel>Call now</span></button>
      <div class="callnote">Uses your microphone. The call is recorded so we can improve the receptionist. <button class="textlink" data-type type="button">Type instead</button></div>
    </div>
    <div class="line-talk">
      <div class="line-head"><span class="line-label">Live transcript</span><div class="wave" aria-hidden="true">${"<span></span>".repeat(14)}</div></div>
      <div class="talk" data-talk aria-live="polite">
        <div class="try"><p>Call and talk the way your customers do. For example:</p>${prompts.map((p) => `<button type="button" data-prompt="${esc(p)}">“${esc(p)}”</button>`).join("")}</div>
      </div>
      <form class="typebar" data-typebar><input data-input placeholder="Type what a caller would say" autocomplete="off" aria-label="Message"><button>Send</button></form>
    </div>
    <div class="line-rail" data-rail><div class="line-label">What it did</div><p class="rail-empty" data-empty>Bookings, messages and calendar checks appear here as the call happens.</p></div>
  </div>`;
  const $ = (s) => root.querySelector(s), talk = $("[data-talk]"), rail = $("[data-rail]");
  let conv = null, started = null, raf = 0, poll = 0, textOnly = false, lastBooking = "", greeted = null;

  let lastUser = "";
  const say = (role, text) => {
    if (role === "user") { if (text === lastUser) return; lastUser = text; }
    $(".try")?.remove();
    const d = document.createElement("div"); d.className = `msg ${role}`;
    d.innerHTML = role === "sys" ? esc(text) : `<small>${role === "ai" ? "Receptionist" : "Caller"}</small>${esc(text)}`;
    talk.appendChild(d); talk.scrollTop = talk.scrollHeight;
  };
  const status = (s) => { $("[data-status]").textContent = s; };
  // after a booking or a message, show exactly what was saved (read back from the business's own records)
  async function showResult() {
    if (!vars?.business_id?.startsWith("demo-")) return;
    const r = await fetch(`/api/latest/${vars.business_id}?since=${encodeURIComponent(started)}`).then((x) => x.json()).catch(() => null);
    if (!r) return;
    for (const [i, t] of (r.tools || []).entries()) {
      const key = `${t.tool}-${t.at}`; if (rail.querySelector(`[data-t="${key}"]`)) continue;
      $("[data-empty]")?.remove();
      const el = document.createElement("div"); el.className = `step${t.ok ? " done" : ""}`; el.dataset.t = key;
      el.innerHTML = `<span class="dot"></span><span><b>${esc((STEPS[t.tool] || [t.tool, t.tool])[t.ok ? 1 : 0])}</b>${esc(new Date(t.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }))}</span>`;
      rail.appendChild(el);
    }
    const b = r.bookings.at(-1);
    if (b && b.when + b.status !== lastBooking) {
      lastBooking = b.when + b.status;
      const c = document.createElement("div"); c.className = "card-booked";
      c.innerHTML = `<div class="k">${b.status === "cancelled" ? "Cancelled" : b.moved_from ? "Moved" : "On the calendar"}</div><div class="v">${esc(b.service)}</div><div class="s">${esc(b.when)}${b.name ? ` · ${esc(b.name)}` : ""}</div>${b.notes ? `<div class="s">${esc(b.notes)}</div>` : ""}`;
      rail.appendChild(c);
    }
    for (const m of r.messages.slice(-1)) if (!rail.querySelector(`[data-msg="${esc(m.name)}"]`)) {
      const c = document.createElement("div"); c.className = "card-booked"; c.dataset.msg = m.name;
      c.innerHTML = `<div class="k">Message for the team</div><div class="v">${esc(m.name)}</div><div class="s">${esc(m.need)}</div>`;
      rail.appendChild(c);
    }
  }
  const bars = [...root.querySelectorAll(".wave span")];
  const animate = () => {
    if (!conv) return;
    const v = Math.min(1, (root.dataset.mode === "speaking" ? conv.getOutputVolume?.() : conv.getInputVolume?.()) * 3 || 0);
    bars.forEach((b, i) => { b.style.height = `${4 + Math.round(v * 18 * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + Date.now() / 180))))}px`; });
    raf = requestAnimationFrame(animate);
  };

  async function start(asText = false) {
    if (!agentId) { say("sys", "The demo line is being set up. Please try again in a few minutes."); return; }
    textOnly = asText; root.dataset.state = "connecting"; status(asText ? "Opening a text line…" : "Connecting… allow the microphone if asked.");
    $("[data-calllabel]").textContent = "Connecting…";
    started = new Date(Date.now() - 2000).toISOString();
    try {
      const { Conversation } = await import(SDK);
      conv = await Conversation.startSession({
        agentId, dynamicVariables: vars, connectionType: asText ? "websocket" : "webrtc", ...(asText ? { textOnly: true } : {}),
        onConnect: () => { root.dataset.state = "live"; status(asText ? "Connected. Type below." : "Connected. Speak normally."); $("[data-calllabel]").textContent = "Hang up"; if (asText) $("[data-input]").focus(); },
        onDisconnect: () => end(true),
        onError: (m) => { say("sys", `Line error: ${m}`); },
        onMessage: ({ message, source, role }) => { if (!message) return; const who = (role || source) === "user" ? "user" : "ai"; say(who, message); if (who === "ai" && greeted) { greeted(); greeted = null; } },
        onModeChange: ({ mode }) => { root.dataset.mode = mode; },
        onAgentToolResponse: () => setTimeout(showResult, 400),
      });
      if (!asText) animate();
      poll = setInterval(showResult, 3000);
    } catch (e) {
      root.dataset.state = "idle"; $("[data-calllabel]").textContent = "Call now";
      const denied = /permission|notallowed|denied/i.test(String(e?.message || e));
      status(denied ? "Microphone blocked. You can type instead." : "Couldn't connect. Try again, or type instead.");
      if (denied) { root.dataset.typing = "on"; }
      conv = null;
    }
  }
  async function end(remote = false) {
    cancelAnimationFrame(raf); clearInterval(poll);
    const c = conv; conv = null;
    if (c && !remote) await c.endSession().catch(() => {});
    root.dataset.state = "idle"; root.dataset.mode = "";
    status("Call ended. Call again any time.");
    $("[data-calllabel]").textContent = "Call again";
    bars.forEach((b) => { b.style.height = "4px"; });
    if (started) setTimeout(showResult, 800);
  }
  $("[data-call]").addEventListener("click", () => (conv ? end() : start(false)));
  $("[data-type]").addEventListener("click", () => { root.dataset.typing = "on"; if (!conv) start(true); else $("[data-input]").focus(); });
  $("[data-typebar]").addEventListener("submit", (e) => {
    e.preventDefault(); const i = $("[data-input]"), t = i.value.trim(); if (!t) return;
    if (!conv) { const waitHi = afterGreeting(); i.value = ""; start(true).then(async () => { if (!conv) return; await waitHi; conv.sendUserMessage(t); say("user", t); }); return; }
    conv.sendUserMessage(t); if (textOnly) say("user", t); i.value = "";
  });
  const afterGreeting = () => new Promise((ok) => { greeted = ok; setTimeout(ok, 6000); });
  root.querySelectorAll("[data-prompt]").forEach((b) => b.addEventListener("click", async () => {
    root.dataset.typing = "on"; const t = b.dataset.prompt, waitHi = afterGreeting();
    await start(true); if (!conv) return; await waitHi; conv.sendUserMessage(t); say("user", t);
  }));
  return { start, end };
}
