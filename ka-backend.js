/* Kingdom ARC — Supabase backend adapter.
 * Provides the same `window.claude.use(name)` surface the school page was written against
 * (db, user, sample, assets, downloads), implemented on Supabase.
 * Loaded as a classic script BEFORE the school script, after config.js and supabase-js UMD.
 */
(function () {
  'use strict';
  var cfg = window.KA_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
    console.warn('[KA] Supabase not configured; running in demo mode.');
    return;
  }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.KA_SUPABASE = sb;

  var sessionP = sb.auth.getSession().then(function (r) { return r.data.session; });
  var profileP = sessionP.then(function (s) {
    if (!s) return null;
    return sb.from('profiles').select('id, display_name, email, role').eq('id', s.user.id).maybeSingle()
      .then(function (r) { return r.data || { id: s.user.id, email: s.user.email, display_name: '', role: 'student' }; });
  });
  var STAFF = ['mentor', 'council', 'admin'];

  /* ---------------- auth helpers used by the Sign-in page ---------------- */
  window.KA_AUTH = {
    sendCode: function (email) {
      return sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(throwIfErr);
    },
    verify: function (email, token) {
      return sb.auth.verifyOtp({ email: email, token: token, type: 'email' }).then(throwIfErr);
    },
    google: function () {
      return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname + '#access' } });
    },
    signOut: function () { return sb.auth.signOut().then(function () { location.reload(); }); }
  };
  function throwIfErr(r) { if (r && r.error) throw r.error; return r && r.data; }

  /* ---------------- document store on table public.docs ---------------- */
  function parentOf(path) { var p = path.split('/'); p.pop(); return p.join('/'); }
  function snap(path, row) {
    var data = row ? row.data : undefined;
    return {
      id: path.split('/').pop(), exists: !!row,
      data: function () { return data; },
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }
  function qsnap(rows) {
    var docs = rows.map(function (r) { return snap(r.path, r); });
    return { docs: docs, size: docs.length, empty: docs.length === 0, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path: path,
      get: function () {
        return sb.from('docs').select('path,data').eq('path', path).maybeSingle()
          .then(function (r) { if (r.error) throw r.error; return snap(path, r.data); });
      },
      set: function (data) {
        return sb.from('docs').upsert({ path: path, parent: parentOf(path), data: data }, { onConflict: 'path' })
          .then(throwIfErr);
      },
      update: function (patch) {
        return sb.rpc('docs_merge', { p_path: path, p_patch: patch }).then(throwIfErr);
      },
      delete: function () { return sb.from('docs').delete().eq('path', path).then(throwIfErr); },
      onSnapshot: function (next, error) {
        var self = this, alive = true;
        self.get().then(function (s) { if (alive) next(s); }, function (e) { if (error) error(e); });
        var ch = sb.channel('doc:' + path + ':' + Math.random().toString(36).slice(2))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'path=eq.' + path }, function () {
            self.get().then(function (s) { if (alive) next(s); });
          }).subscribe();
        return function () { alive = false; sb.removeChannel(ch); };
      },
      collection: function (sub) { return colRef(path + '/' + sub); }
    };
  }
  function colRef(path) {
    var q = { order: null, limit: null };
    var api = {
      path: path,
      doc: function (id) { return docRef(path + '/' + id); },
      orderBy: function (f, dir) { q.order = [f, dir]; return api; },
      limit: function (n) { q.limit = n; return api; },
      where: function () { console.warn('[KA] where() filters are applied client-side'); return api; },
      get: function () {
        var r = sb.from('docs').select('path,data').eq('parent', path);
        if (q.limit) r = r.limit(q.limit);
        return r.then(function (res) { if (res.error) throw res.error; return qsnap(res.data || []); });
      },
      onSnapshot: function (next, error) {
        var alive = true;
        var load = function () { api.get().then(function (s) { if (alive) next(s); }, function (e) { if (error) error(e); }); };
        load();
        var ch = sb.channel('col:' + path + ':' + Math.random().toString(36).slice(2))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'parent=eq.' + path }, load)
          .subscribe();
        return function () { alive = false; sb.removeChannel(ch); };
      }
    };
    return api;
  }
  var dbNS = { doc: docRef, collection: colRef };

  /* ---------------- user ---------------- */
  var userNS = {
    id: function () { return sessionP.then(function (s) { return s ? s.user.id : null; }); },
    me: function () { return profileP.then(function (p) { return p ? { id: p.id, name: p.display_name || '', email: p.email || null } : { id: null, name: '', email: null }; }); },
    isOwner: function () { return profileP.then(function (p) { return !!p && p.role === 'admin'; }); },
    canEdit: function () { return profileP.then(function (p) { return !!p && STAFF.indexOf(p.role) >= 0; }); },
    can: function () { return Promise.resolve(null); },
    profiles: function (ids) {
      ids = [].concat(ids || []); if (!ids.length) return Promise.resolve({});
      return sb.from('profiles').select('id, display_name').in('id', ids).then(function (r) {
        var out = {}; (r.data || []).forEach(function (p) { out[p.id] = { id: p.id, name: p.display_name || '' }; }); return out;
      });
    }
  };

  /* ---------------- GLOR AI (Edge Function: glor) ---------------- */
  function sample(input, opts) {
    opts = opts || {};
    var turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    return sessionP.then(function (s) {
      return fetch(cfg.supabaseUrl + '/functions/v1/glor', {
        method: 'POST', signal: opts.signal,
        headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + (s ? s.access_token : cfg.supabaseAnonKey) },
        body: JSON.stringify({ messages: turns, lang: document.documentElement.lang || 'en' })
      });
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { var e = new Error(j.error || 'GLOR AI unavailable'); e.code = res.status === 429 ? 'rate_limited' : 'error'; throw e; });
      var reader = res.body.getReader(), dec = new TextDecoder(), text = '';
      function pump() {
        return reader.read().then(function (c) {
          if (c.done) return { text: text, truncated: false };
          var chunk = dec.decode(c.value, { stream: true }); text += chunk;
          if (opts.onText) opts.onText({ text: text, delta: chunk });
          return pump();
        });
      }
      return pump();
    });
  }

  /* ---------------- student emails (Edge Function: school-mail) ---------------- */
  window.KA_MAIL = function (payload) {
    return sb.functions.invoke('school-mail', { body: payload }).then(function (r) { if (r.error) throw r.error; return r.data; });
  };

  /* ---------------- invitations (database functions) ---------------- */
  window.KA_INVITE = {
    peek: function (code) { return sb.rpc('ka_peek_invite', { p_code: code }).then(function (r) { if (r.error) throw r.error; return r.data; }); },
    redeem: function (code) { return sb.rpc('ka_redeem_invite', { p_code: code }).then(function (r) { if (r.error) throw r.error; return r.data; }); }
  };

  /* ---------------- Apostolic Council: votes and credentials (database functions) ---------------- */
  window.KA_COUNCIL = {
    vote: function (uid, vote, note) { return sb.rpc('ka_cast_vote', { p_uid: uid, p_vote: vote, p_note: note || '' }).then(function (r) { if (r.error) throw r.error; return r.data; }); },
    issue: function (uid, payload) { return sb.rpc('ka_issue_credential', { p_uid: uid, p: payload }).then(function (r) { if (r.error) throw r.error; return r.data; }); },
    revoke: function (uid, reason) { return sb.rpc('ka_revoke_credential', { p_uid: uid, p_reason: reason || '' }).then(function (r) { if (r.error) throw r.error; return r.data; }); }
  };

  window.KA_BUG = {
    report: function (row) { return sb.from('bug_reports').insert(row).then(function (r) { if (r.error) throw r.error; return true; }); },
    list: function (status) { var q = sb.from('bug_reports').select('*').order('created_at', { ascending: false }).limit(100); if (status) q = q.eq('status', status); return q.then(function (r) { if (r.error) throw r.error; return r.data; }); },
    mark: function (id, status, note) { return sb.from('bug_reports').update({ status: status, agent_note: note || null }).eq('id', id).then(function (r) { if (r.error) throw r.error; return true; }); }
  };

  /* ---------------- admin PIN (database functions) ---------------- */
  window.KA_ACT = {
    ping: function (x) { return sb.rpc('ka_track', { p_item: x.item || null, p_title: x.title || null, p_secs: x.secs || 0, p_listen: x.listen || 0, p_visit: !!x.visit,
      p_cur_item: x.curItem || null, p_cur_title: x.curTitle || null, p_view: x.view || null, p_state: x.state || 'active', p_name: x.name || null }).then(function (r) { if (r.error) throw r.error; return true; }); },
    live: function () {
      var since = new Date(Date.now() - 60 * 864e5).toISOString();
      return Promise.all([
        sb.from('study_presence').select('*').order('last_seen', { ascending: false }).limit(500),
        sb.from('study_time').select('*').gte('last_at', since).order('last_at', { ascending: false }).limit(5000)
      ]).then(function (r) { if (r[0].error) throw r[0].error; if (r[1].error) throw r[1].error; return { presence: r[0].data || [], time: r[1].data || [], at: Date.now() }; });
    }
  };
  window.KA_PIN = {
    has: function () { return sb.rpc('ka_has_admin_pin').then(function (r) { if (r.error) throw r.error; return !!r.data; }); },
    check: function (pin) { return sb.rpc('ka_check_admin_pin', { p_pin: pin }).then(function (r) { if (r.error) throw r.error; return r.data; }); },
    set: function (pnew, pold) { return sb.rpc('ka_set_admin_pin', { p_new: pnew, p_old: pold || null }).then(function (r) { if (r.error) throw r.error; return r.data; }); }
  };

  /* ---------------- server-side exam grading (Edge Function: grade) ---------------- */
  window.KA_GRADE = function (payload) {
    return sb.functions.invoke('grade', { body: payload }).then(function (r) {
      if (r.error) throw r.error; return r.data.record;
    });
  };

  /* ---------------- admissions email (Edge Function: notify-application) ---------------- */
  window.KA_NOTIFY = function () {
    return sb.functions.invoke('notify-application', { body: {} }).then(function (r) { if (r.error) throw r.error; return r.data; });
  };

  /* ---------------- uploads (Storage bucket: applications) ---------------- */
  var assetsNS = {
    upload: function (blob) {
      return sessionP.then(function (s) {
        if (!s) throw new Error('Sign in first');
        var ext = (blob.name || '').split('.').pop() || 'bin';
        var key = s.user.id + '/' + Date.now() + '.' + ext.toLowerCase();
        return sb.storage.from('applications').upload(key, blob, { contentType: blob.type, upsert: false }).then(function (r) {
          if (r.error) throw r.error;
          return sb.storage.from('applications').createSignedUrl(key, 60 * 60 * 24 * 365).then(function (u) {
            return { id: key, url: u.data ? u.data.signedUrl : null, sizeBytes: blob.size, contentType: blob.type };
          });
        });
      });
    }
  };

  /* ---------------- downloads ---------------- */
  var downloadsNS = {
    save: function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = req.filename;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ status: 'saved' });
    }
  };

  window.claude = {
    use: function (name) {
      return sessionP.then(function (s) {
        switch (name) {
          case 'db': return s ? dbNS : null;
          case 'user': return userNS;
          case 'sample': return s ? sample : null;
          case 'assets': return s ? assetsNS : null;
          case 'downloads': return downloadsNS;
          default: return null;
        }
      });
    }
  };
})();
