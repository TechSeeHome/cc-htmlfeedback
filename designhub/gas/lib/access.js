// Pure read-side ACL decision (Knowledge Portal design, "Users and
// permissions" section, Slice B0): given the file owner's email, the
// requesting user's email, and the Drive Permission resources returned for
// the file, decide whether the request may read it, and via which grant.
// Drive ACLs are the single permission authority (the standing ADR) - this
// function only interprets what Drive itself already says about the file;
// it consults no roles, no allowlists. The only Drive-API call this
// replaces a live check for is drive.js's dhCanRead_ (the sole place that
// actually calls Drive.Permissions.list) - keeping the decision itself pure
// is what makes it node --test-able without a live Drive connection (D5),
// the same split lib/knowledge.js already uses for the sync walk.
var DH_ACCESS = (function () {
  function normEmail_(s) {
    return String(s || '').toLowerCase();
  }

  // permissions: array of Drive Permission resource shapes
  // ({type: 'user'|'domain'|'group'|'anyone', emailAddress?, domain?, role}).
  // fileOwnerEmail: '' / null / undefined when Drive reports no owner at all
  // (normal for Shared Drive files, which are drive-owned rather than
  // user-owned) - treated as "no owner match possible", never a crash.
  // Contract: never throws, defaults to deny on anything malformed.
  //
  // Grant handling, in the order checked:
  //  - Owner email match -> {allow:true, via:'owner'}. Checked first because
  //    it needs no permissions array at all.
  //  - type='user' whose emailAddress case-insensitively equals actorEmail
  //    -> {allow:true, via:'direct'}.
  //  - type='domain' whose domain field case-insensitively equals the
  //    actor's own email domain -> {allow:true, via:'domain'}. A domain-type
  //    grant scoped to a DIFFERENT domain (Drive supports domain-to-domain
  //    trusted sharing) must not grant access just because this app's web
  //    app is domain-restricted (appsscript.json webapp.access: DOMAIN) -
  //    that restriction only proves the actor is IN some domain the app
  //    accepts, not that this specific permission's domain is theirs.
  //  - type='anyone' -> {allow:true, via:'domain'} (deliberately reported
  //    the same way as an explicit domain grant, not a distinct value). An
  //    "anyone with the link" grant on a file inside a domain-locked web app
  //    still means every domain user who reaches the file's URL can already
  //    see it directly in Drive - denying it here would only hide the doc
  //    from THIS app's serving path while Drive keeps serving it anyway,
  //    which is a more confusing outcome than allowing it.
  //  - type='group' -> never contributes to allow, deliberately. Resolving
  //    group membership needs the Admin Directory API, which this app does
  //    not have (documented limitation, "Group-grant false denials" in the
  //    design doc) - a group-only grant returns {allow:false, via:'none'}
  //    even though the real requester might be a member. Policy is to deny
  //    strictly rather than fail open: most restricted files carry SOME
  //    group grant, so treating group membership as automatically satisfied
  //    would quietly void the whole read check. The denial page's
  //    escalation copy (render.js's deniedHtml) is how a wrongly-denied real
  //    member self-reports instead of silently bouncing off a dead end.
  //  - No matching permission and no owner match -> {allow:false, via:'none'}.
  //
  // Note on the 'via' value space: only 'owner'/'direct'/'domain'/'none' are
  // ever actually returned. A distinct 'shared-drive' reason was considered
  // (surfacing shared-drive-root membership specifically) but is NOT
  // implemented here: the Drive Permission resource's `type` enum is
  // exactly user/group/domain/anyone - there is no separate "shared drive"
  // type. Membership inherited from a shared drive surfaces as an ordinary
  // user- or group-type permission (optionally with
  // permissionDetails.inherited: true), which this function does not
  // special-case in v1 - it already allows via 'direct' for an inherited
  // user-type grant, same as a direct one.
  function decideRead(permissions, actorEmail, fileOwnerEmail) {
    var actor = normEmail_(actorEmail);
    if (!actor) return { allow: false, via: 'none' };
    var atIndex = actor.indexOf('@');
    var actorDomain = atIndex === -1 ? '' : actor.slice(atIndex + 1);

    if (fileOwnerEmail && normEmail_(fileOwnerEmail) === actor) {
      return { allow: true, via: 'owner' };
    }

    var list = Array.isArray(permissions) ? permissions : [];

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.type === 'user' && normEmail_(p.emailAddress) === actor) {
        return { allow: true, via: 'direct' };
      }
    }
    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      if (q && q.type === 'anyone') {
        return { allow: true, via: 'domain' };
      }
      if (q && q.type === 'domain' && actorDomain && normEmail_(q.domain) === actorDomain) {
        return { allow: true, via: 'domain' };
      }
    }
    return { allow: false, via: 'none' };
  }

  // Write-side ACL probe (Knowledge Portal design, "Users and permissions",
  // Slice B1): same permission-list-walking shape as decideRead above, with
  // two deliberate divergences. (1) A permission's ROLE now matters:
  // decideRead allows via ANY role because any grant at all implies at
  // least read access; decideWrite must not - a reader/commenter-only
  // entry must never allow a write, even though decideRead would happily
  // allow read through the very same entries. WRITE_ROLES mirrors Drive's
  // own write-capable role set. type='group' is deliberately never
  // resolved here either, for the identical reason decideRead excludes it
  // (Admin Directory API not available) - see that function's comment; a
  // group-only grant denies regardless of its role. (2) Same security fix
  // as decideRead's (designhub commit 87e5e13, found in Task 1's own
  // review): a domain-type permission's `domain` field must match the
  // ACTOR's own email domain - this app being domain-restricted only
  // proves the actor is in SOME accepted domain, not that this specific
  // permission's domain is theirs. type='anyone' stays unconditional (on
  // role only) - it is correctly domain-agnostic already.
  var WRITE_ROLES = ['writer', 'organizer', 'fileOrganizer', 'owner'];

  function decideWrite(permissions, actorEmail, fileOwnerEmail) {
    var actor = normEmail_(actorEmail);
    if (!actor) return { allow: false, via: 'none' };
    var atIndex = actor.indexOf('@');
    var actorDomain = atIndex === -1 ? '' : actor.slice(atIndex + 1);

    if (fileOwnerEmail && normEmail_(fileOwnerEmail) === actor) {
      return { allow: true, via: 'owner' };
    }

    var list = Array.isArray(permissions) ? permissions : [];

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.type === 'user' && WRITE_ROLES.indexOf(p.role) !== -1 && normEmail_(p.emailAddress) === actor) {
        return { allow: true, via: 'direct' };
      }
    }
    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      if (q && q.type === 'anyone' && WRITE_ROLES.indexOf(q.role) !== -1) {
        return { allow: true, via: 'domain' };
      }
      if (
        q &&
        q.type === 'domain' &&
        WRITE_ROLES.indexOf(q.role) !== -1 &&
        actorDomain &&
        normEmail_(q.domain) === actorDomain
      ) {
        return { allow: true, via: 'domain' };
      }
    }
    return { allow: false, via: 'none' };
  }

  return { decideRead: decideRead, decideWrite: decideWrite };
})();
if (typeof module !== 'undefined') module.exports = DH_ACCESS;
