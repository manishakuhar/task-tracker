/* ============================================================
   Task Tracker - all app logic
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config / Supabase client ---------- */
  var CFG = window.TASK_TRACKER_CONFIG || {};
  var configured =
    !!CFG.SUPABASE_URL && !!CFG.SUPABASE_ANON_KEY &&
    CFG.SUPABASE_URL.indexOf("YOUR-") === -1 &&
    CFG.SUPABASE_ANON_KEY.indexOf("YOUR-") === -1;

  var sb = configured
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
    : null;

  /* ---------- State ---------- */
  var state = {
    me: null,
    profiles: [],
    invitations: [],
    tickets: [],
    filters: { search: "", assignee: "all", status: "open", priority: "all" },
    signupMode: false
  };
  var activeUploader = null;

  var PRIORITIES = ["urgent", "high", "medium", "low"];
  var PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
  var AVATAR_COLORS = ["#4f46e5","#0891b2","#db2777","#ea580c","#16a34a","#9333ea","#0284c7","#ca8a04"];

  /* ---------- Tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c];
    });
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function initials(name) {
    return (name || "?").trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return (w[0] || "").toUpperCase(); }).join("") || "?";
  }
  function colorFor(id) {
    var h = 0, s = String(id || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9999;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function ago(iso) {
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return d.toLocaleDateString();
  }
  function nameOf(id) {
    if (!id) return "Unassigned";
    var p = state.profiles.find(function (x) { return x.id === id; });
    return p ? p.full_name : "Someone";
  }
  function normalizeEmail(email) {
    return (email || "").trim().toLowerCase();
  }
  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
  }
  function profileByEmail(email) {
    var e = normalizeEmail(email);
    return state.profiles.find(function (p) { return normalizeEmail(p.email) === e; });
  }
  function invitationByEmail(email) {
    var e = normalizeEmail(email);
    return state.invitations.find(function (i) { return normalizeEmail(i.email) === e; });
  }
  function legacyAssignees(t) {
    if (!t.assignee_id && !t.assignee_email) return [];
    return [{
      assignee_id: t.assignee_id || null,
      assignee_email: t.assignee_email || null,
      assignee_name: t.assignee_name || null
    }];
  }
  function ticketAssignees(t) {
    return t.assignees && t.assignees.length ? t.assignees : legacyAssignees(t);
  }
  function assigneeKey(a) {
    if (a.assignee_id) return a.assignee_id;
    if (a.assignee_email) return "email:" + normalizeEmail(a.assignee_email);
    return "";
  }
  function assigneeName(a) {
    if (a.assignee_id) return nameOf(a.assignee_id);
    if (a.assignee_name) return a.assignee_name;
    if (a.assignee_email) return a.assignee_email;
    return "Unassigned";
  }
  function assigneeIdentity(a) {
    return a.assignee_id || a.assignee_email || "";
  }
  function isMine(t) {
    return ticketAssignees(t).some(function (a) {
      return a.assignee_id === state.me.id ||
        (!!a.assignee_email && normalizeEmail(a.assignee_email) === normalizeEmail(state.me.email));
    });
  }
  function canEditTicket(t) {
    return t.created_by === state.me.id;
  }
  function canActOnTicket(t) {
    return canEditTicket(t) || isMine(t);
  }
  function myAssigneeRow(t) {
    return ticketAssignees(t).find(function (a) {
      return a.assignee_id === state.me.id ||
        (!!a.assignee_email && normalizeEmail(a.assignee_email) === normalizeEmail(state.me.email));
    });
  }
  function assigneePartComplete(a) {
    return a.part_status === "done";
  }
  function allPartsDone(t) {
    var assignees = ticketAssignees(t);
    return assignees.length > 0 && assignees.every(assigneePartComplete);
  }
  function partSummary(t) {
    var assignees = ticketAssignees(t);
    if (!assignees.length) return "";
    var done = assignees.filter(assigneePartComplete).length;
    var pending = assignees.length - done;
    return done + " done · " + pending + " pending";
  }
  function publicUrl(path) {
    return sb.storage.from("screenshots").getPublicUrl(path).data.publicUrl;
  }
  function avatar(id, name, big) {
    return '<span class="avatar' + (big ? " lg" : "") + '" style="background:' +
      colorFor(id) + '">' + esc(initials(name)) + "</span>";
  }
  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { hide(t); }, 2600);
  }

  /* ---------- Modal helpers ---------- */
  function openModal(node) {
    closeModal();
    var back = el("div", "modal-backdrop");
    back.appendChild(node);
    back.addEventListener("mousedown", function (e) {
      if (e.target === back) closeModal();
    });
    $("modal-root").appendChild(back);
  }
  function closeModal() {
    $("modal-root").innerHTML = "";
    activeUploader = null;
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("lightbox").hidden) hide($("lightbox"));
      else closeModal();
    }
  });

  /* ---------- Lightbox ---------- */
  function openLightbox(url) {
    var lb = $("lightbox");
    lb.querySelector("img").src = url;
    show(lb);
  }
  $("lightbox").addEventListener("click", function () { hide($("lightbox")); });

  /* ============================================================
     AUTH
     ============================================================ */
  function renderAuthMode() {
    var s = state.signupMode;
    $("name-field").hidden = !s;
    $("auth-submit").textContent = s ? "Create account" : "Sign in";
    $("auth-toggle-text").textContent = s ? "Already have an account?" : "New to the team?";
    $("auth-toggle-btn").textContent = s ? "Sign in" : "Create an account";
    $("auth-password").autocomplete = s ? "new-password" : "current-password";
    hide($("auth-error"));
    hide($("auth-note"));
  }

  function authError(msg) {
    var e = $("auth-error");
    e.textContent = msg;
    show(e);
  }
  function friendlyAuthError(err) {
    var msg = (err && err.message) || "Something went wrong.";
    if (/rate limit/i.test(msg)) {
      return "Supabase has temporarily blocked auth emails because too many invite/sign-in emails were sent. Wait about an hour, or ask the admin to set up custom SMTP in Supabase.";
    }
    return msg;
  }

  $("auth-toggle-btn").addEventListener("click", function () {
    state.signupMode = !state.signupMode;
    renderAuthMode();
  });

  $("auth-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("auth-email").value.trim();
    var pass = $("auth-password").value;
    var name = $("auth-name").value.trim();
    var btn = $("auth-submit");
    hide($("auth-error"));
    hide($("auth-note"));

    if (state.signupMode && !name) { authError("Please enter your name."); return; }
    btn.disabled = true;
    btn.textContent = state.signupMode ? "Creating..." : "Signing in...";

    try {
      if (state.signupMode) {
        var su = await sb.auth.signUp({
          email: email, password: pass,
          options: { data: { full_name: name } }
        });
        if (su.error) throw su.error;
        if (!su.data.session) {
          var note = $("auth-note");
          note.textContent =
            "Account created. Check your email to confirm, then sign in. " +
            "(Tip: turn off email confirmation in Supabase to skip this.)";
          show(note);
          state.signupMode = false;
          renderAuthMode();
        }
      } else {
        var si = await sb.auth.signInWithPassword({ email: email, password: pass });
        if (si.error) throw si.error;
      }
    } catch (err) {
      authError(friendlyAuthError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = state.signupMode ? "Create account" : "Sign in";
    }
  });

  $("magic-link-btn").addEventListener("click", async function () {
    var email = $("auth-email").value.trim();
    var btn = $("magic-link-btn");
    hide($("auth-error"));
    hide($("auth-note"));
    if (!validEmail(email)) { authError("Please enter a valid email first."); return; }

    btn.disabled = true;
    btn.textContent = "Sending link...";
    try {
      var r = await sendInviteEmail(normalizeEmail(email));
      if (r.error) throw r.error;
      var note = $("auth-note");
      note.textContent = "Check your email for a sign-in link.";
      show(note);
    } catch (err) {
      authError(friendlyAuthError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Email me a sign-in link";
    }
  });

  $("signout-btn").addEventListener("click", async function () {
    await sb.auth.signOut();
  });

  /* ============================================================
     DATA LOADING
     ============================================================ */
  async function loadMe(user) {
    var r = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
    var name = (user.user_metadata && user.user_metadata.full_name) ||
      (user.email || "").split("@")[0];
    if (r.data) {
      state.me = r.data;
      if (!state.me.email && user.email) {
        await sb.from("profiles").update({ email: user.email }).eq("id", user.id);
        state.me.email = user.email;
      }
      await resolvePendingAssignments();
      return;
    }
    // fallback if the trigger has not created the row
    await sb.from("profiles").upsert({ id: user.id, full_name: name, email: user.email });
    state.me = { id: user.id, full_name: name, email: user.email };
    await resolvePendingAssignments();
  }

  async function resolvePendingAssignments() {
    if (!state.me || !state.me.email) return;
    var email = normalizeEmail(state.me.email);
    await sb.from("tickets")
      .update({
        assignee_id: state.me.id,
        assignee_email: email,
        assignee_name: state.me.full_name
      })
      .eq("assignee_email", email)
      .or("assignee_id.is.null,assignee_id.eq." + state.me.id);
    await sb.from("ticket_assignees")
      .update({
        assignee_id: state.me.id,
        assignee_email: email,
        assignee_name: state.me.full_name
      })
      .eq("assignee_email", email)
      .or("assignee_id.is.null,assignee_id.eq." + state.me.id);
    await sb.from("invitations")
      .update({ status: "accepted", full_name: state.me.full_name })
      .eq("email", email);
  }

  async function loadProfiles() {
    var r = await sb.from("profiles").select("*").order("full_name");
    state.profiles = r.data || [];
  }

  async function loadInvitations() {
    var r = await sb.from("invitations")
      .select("*")
      .eq("status", "pending")
      .order("full_name");
    if (r.error) {
      console.error(r.error);
      state.invitations = [];
      return;
    }
    state.invitations = (r.data || []).filter(function (i) {
      return !profileByEmail(i.email);
    });
  }

  async function loadTickets() {
    var cols =
      "id,title,description,priority,status,assignee_id,assignee_email,assignee_name,created_by,reopen_count," +
      "created_at,updated_at," +
      "comments(count),attachments(id,storage_path,file_name)";
    var r = await sb.from("tickets").select(cols).order("created_at", { ascending: false });
    if (r.error) { console.error(r.error); toast("Could not load tickets"); return; }
    state.tickets = r.data || [];
    await loadTicketAssignees();
  }

  async function loadTicketAssignees() {
    if (!state.tickets.length) return;
    var ids = state.tickets.map(function (t) { return t.id; });
    var r = await sb.from("ticket_assignees")
      .select("id,ticket_id,assignee_id,assignee_email,assignee_name,part_status,completed_at")
      .in("ticket_id", ids);
    if (r.error) {
      console.warn("Could not load multi-assignees; using legacy assignee fields.", r.error);
      state.tickets.forEach(function (t) { t.assignees = legacyAssignees(t); });
      return;
    }
    var grouped = {};
    (r.data || []).forEach(function (a) {
      if (!grouped[a.ticket_id]) grouped[a.ticket_id] = [];
      grouped[a.ticket_id].push(a);
    });
    state.tickets.forEach(function (t) {
      t.assignees = grouped[t.id] || legacyAssignees(t);
    });
  }

  function commentCount(t) {
    return (t.comments && t.comments[0] && t.comments[0].count) || 0;
  }
  function commentLabel(count) {
    return count + " " + (count === 1 ? "comment" : "comments");
  }

  /* ============================================================
     FILTERING + RENDERING THE BOARD
     ============================================================ */
  function filteredTickets() {
    var f = state.filters, q = f.search.toLowerCase();
    var list = state.tickets.filter(function (t) {
      if (f.status !== "all" && t.status !== f.status) return false;
      if (f.priority !== "all" && t.priority !== f.priority) return false;
      if (f.assignee === "unassigned") {
        if (ticketAssignees(t).length) return false;
      } else if (f.assignee !== "all") {
        if (!ticketAssignees(t).some(function (a) { return assigneeKey(a) === f.assignee; })) return false;
      }
      if (q && (t.title + " " + (t.description || "")).toLowerCase().indexOf(q) === -1)
        return false;
      return true;
    });
    list.sort(function (a, b) {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      if (PRIO_RANK[a.priority] !== PRIO_RANK[b.priority])
        return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
      return new Date(b.created_at) - new Date(a.created_at);
    });
    return list;
  }

  function renderStats() {
    var t = state.tickets;
    var open = t.filter(function (x) { return x.status === "open"; });
    var mineOpen = open.filter(isMine);
    var urgentOpen = open.filter(function (x) { return x.priority === "urgent"; });
    $("stats").innerHTML =
      stat(open.length, "open") +
      stat(mineOpen.length, "assigned to me") +
      stat(urgentOpen.length, "urgent open") +
      stat(t.filter(function (x) { return x.status === "done"; }).length, "done");
  }
  function stat(n, label) {
    return '<div class="stat"><b>' + n + "</b> " + label + "</div>";
  }

  function renderAssigneeFilter() {
    var sel = $("filter-assignee");
    var cur = state.filters.assignee;
    var opts = '<option value="all">All assignees</option>' +
      '<option value="unassigned">Unassigned</option>';
    state.profiles.forEach(function (p) {
      var label = p.id === state.me.id ? p.full_name + " (me)" : p.full_name;
      opts += '<option value="' + p.id + '">' + esc(label) + "</option>";
    });
    state.invitations.forEach(function (i) {
      var key = "email:" + normalizeEmail(i.email);
      opts += '<option value="' + esc(key) + '">' + esc(i.full_name) + " (invited)</option>";
    });
    sel.innerHTML = opts;
    sel.value = Array.from(sel.options).some(function (o) { return o.value === cur; }) ? cur : "all";
    state.filters.assignee = sel.value;
  }

  function renderBoard() {
    renderStats();
    var grid = $("ticket-grid");
    var list = filteredTickets();
    grid.innerHTML = "";

    if (!list.length) {
      hide(grid);
      var es = $("empty-state");
      es.textContent = state.tickets.length
        ? "No tickets match these filters."
        : "No tickets yet. Click “+ New ticket” to raise the first one.";
      show(es);
      return;
    }
    hide($("empty-state"));
    show(grid);

    list.forEach(function (t) {
      grid.appendChild(ticketCard(t));
    });
    // sync the My-tickets chip
    $("my-tickets-btn").classList.toggle(
      "chip-active", state.filters.assignee === state.me.id);
  }

  function ticketCard(t) {
    var atts = t.attachments || [];
    var card = el("article", "card" + (atts.length ? " has-shot" : "") +
      " prio-" + t.priority + " status-" + t.status);
    card.dataset.id = t.id;

    var cover = "";
    if (atts.length) {
      var u0 = publicUrl(atts[0].storage_path);
      cover = '<div class="card-cover">' +
        '<img src="' + u0 + '" data-full="' + u0 + '" alt="screenshot">' +
        (atts.length > 1
          ? '<span class="more-count">+' + (atts.length - 1) + " more</span>"
          : "") +
        "</div>";
    }

    var badges = '<span class="badge prio-' + t.priority + '">' + t.priority + "</span>";
    if (t.status === "done") badges += '<span class="badge done">Done</span>';
    if (t.reopen_count > 0)
      badges += '<span class="badge reopen">Reopened ' + t.reopen_count + "x</span>";
    var summary = partSummary(t);
    if (summary) badges += '<span class="badge progress">' + esc(summary) + "</span>";

    var cc = commentCount(t);
    var assignees = ticketAssignees(t);
    var assigneesHtml = assignees.length
      ? assignees.map(function (a) {
          return '<span class="assignee-pill">' +
            avatar(assigneeIdentity(a), assigneeName(a)) +
            '<span>' + esc(assigneeName(a)) + '</span>' +
            (assigneePartComplete(a) ? ' <small class="done-tag">done</small>' : "") +
            (a.assignee_email && !a.assignee_id ? ' <small class="pending-tag">invited</small>' : "") +
          "</span>";
        }).join("")
      : '<span class="assignee-pill">' + avatar("", "Unassigned") + "<span>Unassigned</span></span>";
    var myPart = myAssigneeRow(t);
    var actionBtn = "";
    if (myPart && t.status === "open") {
      actionBtn = assigneePartComplete(myPart)
        ? '<button class="btn btn-ghost btn-sm" data-act="part-open">Reopen</button>'
        : '<button class="btn btn-ghost btn-sm" data-act="part-done">Mark done</button>';
    } else if (canEditTicket(t)) {
      if (t.status === "open" && (!ticketAssignees(t).length || allPartsDone(t))) {
        actionBtn = '<button class="btn btn-ghost btn-sm" data-act="done">Mark done</button>';
      } else if (t.status === "done") {
        actionBtn = '<button class="btn btn-ghost btn-sm" data-act="reopen">Reopen</button>';
      }
    }

    card.innerHTML =
      cover +
      '<div class="card-pad">' +
        '<div class="card-top">' + badges + "</div>" +
        '<p class="card-text">' + esc(t.title) + "</p>" +
        '<div class="card-foot">' +
          '<div class="assignee-list">' + assigneesHtml + "</div>" +
          '<span class="meta">' +
            "💬 " + commentLabel(cc) + " · " + ago(t.created_at) +
          "</span>" +
        "</div>" +
        '<div class="card-actions">' + actionBtn + "</div>" +
      "</div>";

    card.addEventListener("click", function (e) {
      var img = e.target.closest("img[data-full]");
      if (img) { e.stopPropagation(); openLightbox(img.dataset.full); return; }
      var act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === "part-done") setMyPartStatus(t, "done");
        else if (act.dataset.act === "part-open") setMyPartStatus(t, "open");
        else if (act.dataset.act === "done") setStatus(t, "done");
        else reopen(t);
        return;
      }
      openDetail(t.id);
    });
    return card;
  }

  /* ============================================================
     TICKET ACTIONS
     ============================================================ */
  async function setStatus(t, status) {
    var body = prompt(status === "done"
      ? "Add a comment before marking this ticket done:"
      : "Add a comment before reopening this ticket:");
    if (body == null) return;
    body = body.trim();
    if (!body) { toast("Comment is required"); return; }

    var r = await sb.from("tickets").update({ status: status }).eq("id", t.id);
    if (r.error) { toast(r.error.message); return; }
    var comment = await sb.from("comments").insert({
      ticket_id: t.id,
      author_id: state.me.id,
      body: (status === "done" ? "Marked done: " : "Reopened: ") + body
    });
    if (comment.error) { toast(comment.error.message); return; }
    toast(status === "done" ? "Marked done" : "Ticket updated");
    await refresh();
  }

  async function reopen(t) {
    var body = prompt("Add a comment before reopening this ticket:");
    if (body == null) return;
    body = body.trim();
    if (!body) { toast("Comment is required"); return; }

    var r = await sb.from("tickets")
      .update({ status: "open", reopen_count: (t.reopen_count || 0) + 1 })
      .eq("id", t.id);
    if (r.error) { toast(r.error.message); return; }
    var comment = await sb.from("comments").insert({
      ticket_id: t.id,
      author_id: state.me.id,
      body: "Reopened: " + body
    });
    if (comment.error) { toast(comment.error.message); return; }
    toast("Ticket reopened");
    await refresh();
  }

  async function setMyPartStatus(t, status) {
    var mine = myAssigneeRow(t);
    if (!mine) { toast("This ticket is not assigned to you"); return; }

    var body = prompt(status === "done"
      ? "Add a comment for your completed part:"
      : "Add a comment before reopening your part:");
    if (body == null) return;
    body = body.trim();
    if (!body) { toast("Comment is required"); return; }

    var r = await sb.from("ticket_assignees")
      .update({
        part_status: status,
        completed_at: status === "done" ? new Date().toISOString() : null
      })
      .eq("id", mine.id);
    if (r.error) { toast(r.error.message); return; }

    var comment = await sb.from("comments").insert({
      ticket_id: t.id,
      author_id: state.me.id,
      body: (status === "done" ? "My part is done: " : "Reopened my part: ") + body
    });
    if (comment.error) { toast(comment.error.message); return; }

    var updatedAssignees = ticketAssignees(t).map(function (a) {
      return a.id === mine.id
        ? { ...a, part_status: status, completed_at: status === "done" ? new Date().toISOString() : null }
        : a;
    });
    if (status === "done" && updatedAssignees.length && updatedAssignees.every(assigneePartComplete)) {
      await sb.from("tickets").update({ status: "done" }).eq("id", t.id);
      await sb.from("comments").insert({
        ticket_id: t.id,
        author_id: state.me.id,
        body: "All assigned parts are done. Ticket marked done."
      });
    } else if (status === "open" && t.status === "done") {
      await sb.from("tickets")
        .update({ status: "open", reopen_count: (t.reopen_count || 0) + 1 })
        .eq("id", t.id);
    }

    toast(status === "done" ? "Your part is done" : "Your part was reopened");
    await refresh();
  }

  async function updateTicket(id, patch) {
    var r = await sb.from("tickets").update(patch).eq("id", id);
    if (r.error) { toast(r.error.message); return false; }
    await refresh();
    return true;
  }

  async function deleteTicket(t) {
    if (!confirm("Delete this ticket for everyone? This cannot be undone.")) return;
    if (t.attachments && t.attachments.length) {
      try {
        await sb.storage.from("screenshots")
          .remove(t.attachments.map(function (a) { return a.storage_path; }));
      } catch (e) { /* best effort */ }
    }
    var r = await sb.from("tickets").delete().eq("id", t.id);
    if (r.error) { toast(r.error.message); return; }
    closeModal();
    toast("Ticket deleted");
    await refresh();
  }

  /* ---------- Screenshot upload ---------- */
  async function uploadFiles(ticketId, files) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var ext = ((f.name || "image.png").split(".").pop() || "png").toLowerCase();
      var path = ticketId + "/" + Date.now() + "-" +
        Math.random().toString(36).slice(2, 8) + "." + ext;
      var up = await sb.storage.from("screenshots")
        .upload(path, f, { contentType: f.type || "image/png" });
      if (up.error) throw up.error;
      var ins = await sb.from("attachments").insert({
        ticket_id: ticketId, storage_path: path, file_name: f.name || "screenshot.png"
      });
      if (ins.error) throw ins.error;
    }
  }

  async function deleteAttachment(att) {
    try { await sb.storage.from("screenshots").remove([att.storage_path]); }
    catch (e) { /* best effort */ }
    await sb.from("attachments").delete().eq("id", att.id);
    await refresh();
  }

  /* ============================================================
     UPLOADER WIDGET (click, drag-drop, paste)
     ============================================================ */
  function createUploader(onFilesAdded) {
    var wrap = el("div", "uploader");
    wrap.innerHTML =
      '<div class="dropzone" tabindex="0">' +
        '<input type="file" accept="image/*" multiple hidden>' +
        '<div class="dz-icon">🖼️</div>' +
        "<div><strong>Paste a screenshot</strong> (Ctrl/Cmd+V)</div>" +
        '<div class="dz-sub">or click to choose, or drag an image here</div>' +
        '<button type="button" class="paste-btn">Paste from clipboard</button>' +
      "</div>" +
      '<div class="upload-thumbs"></div>';
    var input = wrap.querySelector("input");
    var dz = wrap.querySelector(".dropzone");
    var pasteBtn = wrap.querySelector(".paste-btn");
    var thumbs = wrap.querySelector(".upload-thumbs");
    var files = [];

    function addFiles(list) {
      var added = [];
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (f && f.type && f.type.indexOf("image/") === 0) {
          files.push(f);
          added.push(f);
        }
      }
      render();
      if (added.length && typeof onFilesAdded === "function") onFilesAdded(added);
    }
    async function pasteFromClipboard() {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        toast("Use Ctrl/Cmd+V, or click to choose the image");
        dz.focus();
        return;
      }
      try {
        var items = await navigator.clipboard.read();
        var pasted = [];
        for (var i = 0; i < items.length; i++) {
          var types = items[i].types || [];
          for (var j = 0; j < types.length; j++) {
            if (types[j].indexOf("image/") === 0) {
              var blob = await items[i].getType(types[j]);
              var ext = types[j].split("/")[1] || "png";
              pasted.push(new File([blob], "clipboard-image." + ext, { type: types[j] }));
            }
          }
        }
        if (!pasted.length) { toast("No image found in clipboard"); return; }
        addFiles(pasted);
      } catch (err) {
        toast("Clipboard access was blocked. Try Ctrl/Cmd+V instead.");
        dz.focus();
      }
    }
    function render() {
      thumbs.innerHTML = "";
      files.forEach(function (f, idx) {
        var t = el("div", "upload-thumb");
        t.innerHTML = '<img src="' + URL.createObjectURL(f) + '">' +
          '<button type="button" class="rm" data-i="' + idx + '">×</button>';
        thumbs.appendChild(t);
      });
    }
    thumbs.addEventListener("click", function (e) {
      var b = e.target.closest(".rm");
      if (!b) return;
      files.splice(parseInt(b.dataset.i, 10), 1);
      render();
    });
    dz.addEventListener("click", function (e) {
      if (e.target.closest(".paste-btn")) return;
      input.click();
    });
    pasteBtn.addEventListener("click", pasteFromClipboard);
    input.addEventListener("change", function () {
      addFiles(input.files); input.value = "";
    });
    dz.addEventListener("dragover", function (e) {
      e.preventDefault(); dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("drag");
      addFiles(e.dataTransfer.files);
    });

    var api = {
      el: wrap,
      getFiles: function () { return files; },
      clear: function () { files = []; render(); },
      addFiles: addFiles,
      focus: function () { dz.focus(); }
    };
    activeUploader = api;
    return api;
  }

  document.addEventListener("paste", function (e) {
    if (!activeUploader) return;
    var imgs = [];
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      for (var fidx = 0; fidx < files.length; fidx++) {
        if (files[fidx].type && files[fidx].type.indexOf("image/") === 0) {
          imgs.push(files[fidx]);
        }
      }
    }
    var items = e.clipboardData && e.clipboardData.items;
    if (!items && !imgs.length) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var f = items[i].getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) { e.preventDefault(); activeUploader.addFiles(imgs); }
  });

  /* ============================================================
     NEW TICKET MODAL
     ============================================================ */
  function priorityOptions(selected) {
    return PRIORITIES.map(function (p) {
      return '<option value="' + p + '"' + (p === selected ? " selected" : "") +
        ">" + cap(p) + "</option>";
    }).join("");
  }
  function prioChips(selected) {
    return ["low", "medium", "high", "urgent"].map(function (p) {
      return '<button type="button" class="pchip pchip-' + p +
        (p === selected ? " pchip-on" : "") + '" data-p="' + p + '">' +
        cap(p) + "</button>";
    }).join("");
  }
  function assigneePicker(selected, disabled) {
    selected = selected || [];
    if (!Array.isArray(selected)) selected = selected ? [selected] : [];
    var html = '<div class="assignee-picker' + (disabled ? " disabled" : "") + '">';
    state.profiles.forEach(function (p) {
      var label = p.id === state.me.id ? p.full_name + " (me)" : p.full_name;
      html += '<label class="assignee-option">' +
        '<input type="checkbox" value="' + p.id + '"' +
        (selected.indexOf(p.id) !== -1 ? " checked" : "") +
        (disabled ? " disabled" : "") + "> " +
        '<span>' + esc(label) + "</span></label>";
    });
    state.invitations.forEach(function (i) {
      var key = "email:" + normalizeEmail(i.email);
      html += '<label class="assignee-option">' +
        '<input type="checkbox" value="' + esc(key) + '"' +
        (selected.indexOf(key) !== -1 ? " checked" : "") +
        (disabled ? " disabled" : "") + "> " +
        '<span>' + esc(i.full_name) + " (invited)</span></label>";
    });
    if (html === '<div class="assignee-picker' + (disabled ? " disabled" : "") + '">') {
      html += '<div class="muted empty-assignees">No people added yet.</div>';
    }
    html += "</div>";
    return html;
  }

  function selectedAssigneeRecord(value) {
    if (!value) return null;
    if (value.indexOf("email:") === 0) {
      var email = normalizeEmail(value.slice(6));
      var invite = invitationByEmail(email);
      return {
        assignee_id: null,
        assignee_email: email,
        assignee_name: invite ? invite.full_name : email
      };
    }
    var p = state.profiles.find(function (x) { return x.id === value; });
    return {
      assignee_id: value,
      assignee_email: p ? normalizeEmail(p.email) : null,
      assignee_name: p ? p.full_name : null
    };
  }

  function selectedAssigneeRecords(container) {
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
      .map(function (input) { return selectedAssigneeRecord(input.value); })
      .filter(Boolean);
  }

  function assigneePatchFor(records) {
    var first = records[0];
    return first ? {
      assignee_id: first.assignee_id,
      assignee_email: first.assignee_email,
      assignee_name: first.assignee_name
    } : {
      assignee_id: null,
      assignee_email: null,
      assignee_name: null
    };
  }

  function assigneeKeysForTicket(t) {
    return ticketAssignees(t).map(assigneeKey).filter(Boolean);
  }

  function assigneeRecordsEqual(a, b) {
    var ak = a.map(assigneeKey).sort().join("|");
    var bk = b.map(assigneeKey).sort().join("|");
    return ak === bk;
  }

  async function replaceTicketAssignees(ticketId, records) {
    await sb.from("ticket_assignees").delete().eq("ticket_id", ticketId);
    if (!records.length) return;
    var rows = records.map(function (a) {
      return {
        ticket_id: ticketId,
        assignee_id: a.assignee_id,
        assignee_email: a.assignee_email,
        assignee_name: a.assignee_name,
        part_status: a.part_status || "open",
        completed_at: a.completed_at || null
      };
    });
    var r = await sb.from("ticket_assignees").insert(rows);
    if (r.error) throw r.error;
  }

  async function sendInviteEmail(email) {
    if (!CFG.APP_URL || /localhost|127\.0\.0\.1/i.test(CFG.APP_URL)) {
      return {
        error: new Error("APP_URL must be set to the deployed Vercel URL in config.js before sending email links.")
      };
    }
    var redirectBase = CFG.APP_URL.replace(/\/+$/, "");
    var redirectTo = redirectBase + location.pathname;
    return sb.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true }
    });
  }

  async function createInvitation(name, email) {
    email = normalizeEmail(email);
    if (!name) throw new Error("Please enter their name.");
    if (!validEmail(email)) throw new Error("Please enter a valid email.");

    await loadProfiles();
    var existing = profileByEmail(email);
    if (existing) return { profile: existing };

    var saved = await sb.from("invitations").upsert({
      email: email,
      full_name: name,
      status: "pending",
      invited_by: state.me.id
    }, { onConflict: "email" }).select().single();
    if (saved.error) throw saved.error;

    var invite = await sendInviteEmail(email);
    if (invite.error) throw invite.error;
    await loadInvitations();
    return { invitation: saved.data };
  }

  function openInvitePerson() {
    var modal = el("div", "modal");
    modal.innerHTML =
      '<div class="modal-head"><h2>Invite person</h2>' +
        '<button class="icon-btn" data-close>×</button></div>' +
      '<div class="modal-body">' +
        '<label class="field"><span>Name</span>' +
          '<input id="invite-name" type="text" autocomplete="name" placeholder="Jane Doe"></label>' +
        '<label class="field"><span>Email</span>' +
          '<input id="invite-email" type="email" autocomplete="email" placeholder="jane@company.com"></label>' +
        '<p class="muted invite-help">They will get a Supabase email link. Any tickets assigned to this email will appear under My tickets after they sign in.</p>' +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="invite-send">Send invite</button>' +
      "</div>";

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) closeModal();
    });
    modal.querySelector("#invite-send").addEventListener("click", async function () {
      var btn = this;
      var name = modal.querySelector("#invite-name").value.trim();
      var email = modal.querySelector("#invite-email").value.trim();
      btn.disabled = true; btn.textContent = "Sending...";
      try {
        var result = await createInvitation(name, email);
        closeModal();
        toast(result.profile ? "They already have an account" : "Invite sent");
        await refresh();
      } catch (err) {
        btn.disabled = false; btn.textContent = "Send invite";
        toast(friendlyAuthError(err));
      }
    });

    openModal(modal);
    setTimeout(function () { modal.querySelector("#invite-name").focus(); }, 30);
  }

  function openNewTicket() {
    var prio = "medium";
    var modal = el("div", "modal");
    modal.innerHTML =
      '<div class="modal-head"><h2>New ticket</h2>' +
        '<button class="icon-btn" data-close>×</button></div>' +
      '<div class="modal-body">' +
        '<div class="field"><span>Screenshot</span><div id="nt-uploader"></div></div>' +
	        '<label class="field"><span>What needs to be done?</span>' +
	          '<textarea id="nt-text" rows="3" placeholder="Describe the task in a line or two..."></textarea></label>' +
	        '<div class="field"><span>Assign to</span>' +
	          '<div id="nt-assignee">' + assigneePicker([]) + "</div>" +
	          '<small class="field-help">Tick one or more people. Leave blank for unassigned.</small></div>' +
        '<div class="field"><span>Priority</span>' +
          '<div class="prio-chips" id="nt-prio">' + prioChips(prio) + "</div></div>" +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="nt-create">Create ticket</button>' +
      "</div>";

    var uploader = createUploader();
    modal.querySelector("#nt-uploader").appendChild(uploader.el);

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) closeModal();
    });

    modal.querySelector("#nt-prio").addEventListener("click", function (e) {
      var c = e.target.closest(".pchip");
      if (!c) return;
      prio = c.dataset.p;
      modal.querySelectorAll("#nt-prio .pchip").forEach(function (x) {
        x.classList.toggle("pchip-on", x === c);
      });
    });

    modal.querySelector("#nt-create").addEventListener("click", async function () {
      var btn = this;
      var text = modal.querySelector("#nt-text").value.trim();
      if (!text) { toast("Please write what needs to be done"); return; }
      btn.disabled = true; btn.textContent = "Creating...";
      try {
        var ins = await sb.from("tickets").insert({
          title: text,
          priority: prio,
	          ...assigneePatchFor(selectedAssigneeRecords(modal.querySelector("#nt-assignee"))),
          created_by: state.me.id
        }).select().single();
        if (ins.error) throw ins.error;
        await replaceTicketAssignees(
          ins.data.id,
          selectedAssigneeRecords(modal.querySelector("#nt-assignee"))
        );
        var files = uploader.getFiles();
        if (files.length) await uploadFiles(ins.data.id, files);
        closeModal();
        toast("Ticket created");
        await refresh();
      } catch (err) {
        btn.disabled = false; btn.textContent = "Create ticket";
        toast(err.message || "Could not create ticket");
      }
    });

    openModal(modal);
    setTimeout(function () { uploader.focus(); }, 30);
  }

  /* ============================================================
     TICKET DETAIL MODAL
     ============================================================ */
  async function openDetail(id) {
    var t = state.tickets.find(function (x) { return x.id === id; });
    if (!t) { await refresh(); t = state.tickets.find(function (x) { return x.id === id; }); }
    if (!t) { toast("Ticket not found"); return; }
    var cr = await sb.from("comments")
      .select("id,body,created_at,author_id")
      .eq("ticket_id", id).order("created_at");
    renderDetail(t, cr.data || []);
  }

  function renderDetail(t, comments) {
    var modal = el("div", "modal");
    var canEdit = canEditTicket(t);
    var canAct = canActOnTicket(t);

    var statusPill = t.status === "done"
      ? '<span class="badge done">Done</span>'
      : '<span class="badge prio-' + t.priority + '">Open</span>';
    var reopenBadge = t.reopen_count > 0
      ? '<span class="badge reopen">Reopened ' + t.reopen_count + "x</span>" : "";

	    var shots = '<div class="shot-grid">' +
	      (t.attachments || []).map(function (a) {
	        return '<div class="shot"><img src="' + publicUrl(a.storage_path) +
	          '" data-full="' + publicUrl(a.storage_path) + '" alt="screenshot">' +
	          (canEdit ? '<button class="rm" data-del-att="' + a.id + '">×</button>' : "") +
            "</div>";
	      }).join("") + "</div>";

    var commentsHtml = comments.map(function (c) {
      var canDel = c.author_id === state.me.id;
      return '<div class="comment">' +
        avatar(c.author_id, nameOf(c.author_id)) +
        '<div class="comment-bubble">' +
          '<div class="comment-head"><b>' + esc(nameOf(c.author_id)) + "</b>" +
            '<span class="muted">' + ago(c.created_at) + "</span>" +
            (canDel ? '<button class="comment-del" data-del-comment="' + c.id +
              '">delete</button>' : "") +
          "</div>" +
          '<div class="comment-body">' + esc(c.body) + "</div>" +
        "</div></div>";
    }).join("") || '<p class="muted" style="font-size:.88rem">No comments yet.</p>';
    var assigneeProgressHtml = ticketAssignees(t).length
      ? '<div class="part-list">' + ticketAssignees(t).map(function (a) {
          return '<div class="part-row">' +
            '<span class="assignee-pill">' + avatar(assigneeIdentity(a), assigneeName(a)) +
              '<span>' + esc(assigneeName(a)) + '</span></span>' +
            '<span class="part-status ' + (assigneePartComplete(a) ? "done" : "open") + '">' +
              (assigneePartComplete(a) ? "Done" : "Pending") +
            "</span></div>";
        }).join("") + "</div>"
      : '<p class="muted" style="font-size:.88rem">No assignees yet.</p>';

    modal.innerHTML =
      '<div class="modal-head"><h2>Ticket</h2>' +
        '<button class="icon-btn" data-close>×</button></div>' +
      '<div class="modal-body">' +
        '<div style="margin-bottom:12px">' + statusPill + " " + reopenBadge + "</div>" +
        '<div class="section-label">Task</div>' +
        '<textarea id="d-text" rows="3" class="box"' + (canEdit ? "" : " readonly") + ">" + esc(t.title) + "</textarea>" +
        '<div class="meta-grid" style="margin-top:14px">' +
	          '<div class="meta-item"><span>Priority</span>' +
	            '<select id="d-priority"' + (canEdit ? "" : " disabled") + ">" + priorityOptions(t.priority) + "</select></div>" +
	          '<div class="meta-item"><span>Assigned to</span>' +
	            '<div id="d-assignee">' + assigneePicker(assigneeKeysForTicket(t), !canEdit) + "</div>" +
	            '<small class="field-help">Tick one or more people. Leave blank for unassigned.</small></div>' +
          '<div class="meta-item"><span>Raised by</span>' +
            '<div class="meta-static">' + esc(nameOf(t.created_by)) + "</div></div>" +
          '<div class="meta-item"><span>Created</span>' +
            '<div class="meta-static">' + new Date(t.created_at).toLocaleString() +
            "</div></div>" +
        "</div>" +
        '<div class="section-label">Assignee progress</div>' +
        (partSummary(t) ? '<p class="part-summary">' + esc(partSummary(t)) + "</p>" : "") +
        assigneeProgressHtml +
        '<div class="section-label">Screenshots</div>' +
	        shots +
	        (canEdit ? '<div id="d-uploader" style="margin-top:8px"></div>' : "") +
        '<div class="section-label">Comments</div>' +
        '<div class="comment-list">' + commentsHtml + "</div>" +
        (canAct
          ? '<div class="comment-box">' +
              '<textarea id="d-comment" placeholder="Write a comment..."></textarea>' +
              '<button class="btn btn-primary" id="d-send">Send</button>' +
            "</div>"
          : '<p class="muted view-only-note">Only the creator and assignees can comment or update status.</p>') +
      "</div>" +
      '<div class="modal-foot">' +
        (canEdit ? '<button class="btn btn-danger" id="d-delete">Delete ticket</button>' : '<span></span>') +
        '<div class="modal-actions">' +
          (canEdit ? '<button class="btn btn-ghost" id="d-save" disabled>Save changes</button>' : "") +
          (canAct
            ? (t.status === "open"
                ? '<button class="btn btn-primary" id="d-status">Mark done</button>'
                : '<button class="btn btn-primary" id="d-status">Reopen ticket</button>')
            : "") +
        "</div>" +
      "</div>";

    if (canEdit) {
      var uploader = createUploader(function (files) {
        if (!files.length) return;
        uploadFiles(t.id, files).then(function () {
          uploader.clear();
          toast("Screenshot added");
          openDetail(t.id);
          loadTickets().then(renderBoard);
        }).catch(function (err) { toast(err.message || "Upload failed"); });
      });
      modal.querySelector("#d-uploader").appendChild(uploader.el);
    }

    // close
    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) closeModal();
    });

    // enlarge screenshots
    modal.querySelector(".shot-grid").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-att]");
      if (del) {
        if (!canEdit) return;
        var att = (t.attachments || []).find(function (a) {
          return a.id === del.dataset.delAtt;
        });
        if (att && confirm("Remove this screenshot?")) deleteAttachment(att);
        return;
      }
      var img = e.target.closest("img");
      if (img) openLightbox(img.dataset.full);
    });

    var saveBtn = modal.querySelector("#d-save");
    function currentEditPatch() {
      var assignees = selectedAssigneeRecords(modal.querySelector("#d-assignee"));
      return {
        title: modal.querySelector("#d-text").value.trim(),
        priority: modal.querySelector("#d-priority").value,
        assignees: assignees,
        ...assigneePatchFor(assignees)
      };
    }
    function editsChanged() {
      var patch = currentEditPatch();
      return patch.title !== t.title ||
        patch.priority !== t.priority ||
        !assigneeRecordsEqual(patch.assignees, ticketAssignees(t));
    }
    function markDirty() {
      saveBtn.disabled = !editsChanged();
    }

    if (canEdit) {
      modal.querySelector("#d-text").addEventListener("input", markDirty);
      modal.querySelector("#d-priority").addEventListener("change", markDirty);
      modal.querySelector("#d-assignee").addEventListener("change", markDirty);

      saveBtn.addEventListener("click", async function () {
        var patch = currentEditPatch();
        if (!patch.title) { toast("Task text cannot be empty"); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        var assignees = patch.assignees;
        delete patch.assignees;
        var ok = await updateTicket(t.id, patch);
        if (ok) {
          try {
            await replaceTicketAssignees(t.id, assignees);
            toast("Changes saved");
            closeModal();
            await refresh();
          } catch (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save changes";
            toast(err.message || "Could not save assignees");
          }
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save changes";
        }
      });
    }

    // status button
    var statusBtn = modal.querySelector("#d-status");
    if (statusBtn) {
      statusBtn.addEventListener("click", function () {
        if (t.status === "open") {
          if (ticketAssignees(t).length && !allPartsDone(t)) {
            toast("All assignee parts must be done before closing the ticket");
            return;
          }
          setStatus(t, "done");
        }
        else reopen(t);
      });
    }
    // delete
    var deleteBtn = modal.querySelector("#d-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function () {
        deleteTicket(t);
      });
    }

    // add comment
    async function sendComment() {
      var box = modal.querySelector("#d-comment");
      var body = box.value.trim();
      if (!body) return;
      box.disabled = true;
      var r = await sb.from("comments").insert({
        ticket_id: t.id, author_id: state.me.id, body: body
      });
      box.disabled = false;
      if (r.error) { toast(r.error.message); return; }
      box.value = "";
      openDetail(t.id);
      loadTickets().then(renderBoard);
    }
    var sendBtn = modal.querySelector("#d-send");
    var commentBox = modal.querySelector("#d-comment");
    if (sendBtn && commentBox) {
      sendBtn.addEventListener("click", sendComment);
      commentBox.addEventListener("keydown", function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendComment();
      });
    }

    // delete comment
    modal.querySelector(".comment-list").addEventListener("click", async function (e) {
      var b = e.target.closest("[data-del-comment]");
      if (!b) return;
      await sb.from("comments").delete().eq("id", b.dataset.delComment);
      openDetail(t.id);
    });

    openModal(modal);
  }

  /* ============================================================
     REFRESH + REALTIME
     ============================================================ */
  async function refresh() {
    await loadProfiles();
    await Promise.all([loadInvitations(), loadTickets()]);
    renderAssigneeFilter();
    renderBoard();
  }

  var refreshTimer;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refresh();
    }, 400);
  }

  function startRealtime() {
    sb.channel("task-tracker")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "tickets" }, scheduleRefresh)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "ticket_assignees" }, scheduleRefresh)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "invitations" }, scheduleRefresh)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "comments" }, scheduleRefresh)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "attachments" }, scheduleRefresh)
      .subscribe();
  }

  /* ============================================================
     TOOLBAR WIRING
     ============================================================ */
  $("new-ticket-btn").addEventListener("click", openNewTicket);
  $("invite-person-btn").addEventListener("click", openInvitePerson);

  var searchTimer;
  $("search-input").addEventListener("input", function () {
    var v = this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.filters.search = v;
      renderBoard();
    }, 180);
  });
  $("filter-assignee").addEventListener("change", function () {
    state.filters.assignee = this.value;
    renderBoard();
  });
  $("filter-status").addEventListener("change", function () {
    state.filters.status = this.value;
    renderBoard();
  });
  $("filter-priority").addEventListener("change", function () {
    state.filters.priority = this.value;
    renderBoard();
  });
  $("my-tickets-btn").addEventListener("click", function () {
    var on = state.filters.assignee === state.me.id;
    state.filters.assignee = on ? "all" : state.me.id;
    $("filter-assignee").value = state.filters.assignee;
    renderBoard();
  });

  /* ============================================================
     STARTUP
     ============================================================ */
  async function enterApp(user) {
    await loadMe(user);
    $("current-user").textContent = "Hi, " + state.me.full_name;
    hide($("auth-view"));
    show($("app-view"));
    await refresh();
    startRealtime();
  }

  function showAuth() {
    hide($("app-view"));
    show($("auth-view"));
    renderAuthMode();
  }

  async function start() {
    if (!configured) {
      show($("setup-view"));
      return;
    }
    var sess = await sb.auth.getSession();
    if (sess.data.session) await enterApp(sess.data.session.user);
    else showAuth();

    sb.auth.onAuthStateChange(function (event, session) {
      if (event === "SIGNED_IN" && session && !state.me) enterApp(session.user);
      else if (event === "SIGNED_OUT") {
        state.me = null;
        location.reload();
      }
    });
  }

  start();
})();
