/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * wh_fulfillment_console_sl.js
 * Warehouse Fulfillment Console: Release -> Ready to pick -> Picked -> Packed -> Shipped
 *
 * Routes (same deployment URL)
 *   GET                       page
 *   GET  action=data          board JSON
 *   GET  action=diag          SuiteQL column check (returns only failing columns)
 *   GET  action=ifdetail      item fulfillment detail JSON (&ifid=)
 *   GET  action=ticketpdf     picking tickets PDF (&ids=1,2,3), released qty only
 *   GET  action=packslip      native packing slip PDF (&so=&if=)
 *   POST {action, ...}        release | releaseLines | unrelease | markPrinted | pick | pack |
 *                             shippingCost | label | labelDownloaded | ship
 *
 * Script parameters
 *   custscript_whc_location       List/Record (Location)   warehouse location filter (optional)
 *   custscript_whc_shipped_days   Integer                  days of shipped history (default 2)
 *   custscript_whc_label_url      Free-Form Text           label page template (optional)
 *
 * Release (wh_fulfillment_lib.js)
 *   Who: Administrator role, or employees with custentity_whc_release_access checked.
 *   Each line can be partly released to the warehouse (custcol_whc_release_qty) and partly sent to a
 *   dropship PO. Ready to pick, picking tickets and pick validation use the released qty.
 */
define(['N/ui/serverWidget', 'N/runtime', 'N/url', 'N/log', './wh_fulfillment_lib', 'N/file'],
(serverWidget, runtime, url, log, lib, file) => {

    const json = (res, obj) => {
        res.setHeader({ name: 'Content-Type', value: 'application/json' });
        res.write({ output: JSON.stringify(obj) });
    };

    const POST_ACTIONS = {
        release:         (b) => lib.release(b.soIds),
        releaseLines:    (b) => lib.releaseLines(b.soId, { approve: !!b.approve, lines: b.lines || [] }),
        unrelease:       (b) => lib.unrelease(b.soId),
        markPrinted:     (b) => lib.markPrinted(b.soIds),
        pick:            (b) => lib.pick(b.soId, b.lines),
        pack:            (b) => lib.pack(b.ifId, b.packages),
        shippingCost:    (b, req) => lib.calculateShippingCost(b.ifId, req.headers),
        label:           (b) => lib.printLabel(b.ifIds),
        labelDownloaded: (b) => lib.labelDownloaded(b.ifId, b.zpl),
        ship:            (b) => lib.ship(b.ifIds)
    };

    function onRequest(ctx) {
        const req = ctx.request;
        const res = ctx.response;
        const p = req.parameters;

        try {
            if (req.method === 'GET') {
                switch (p.action || '') {
                    case '':          return renderPage(res);
                    case 'shippingcosts': return json(res, { ok: true, result: lib.getShippingCosts(p.ifids) });
                    case 'labelrendererinfo': {
                        const renderer = file.load({ id: './wh_zpl_renderer.js' });
                        if (!renderer.size) throw new Error('wh_zpl_renderer.js is empty. Upload the renderer file into the Suitelet folder.');
                        return json(res, { ok: true, result: { url: renderer.url, size: renderer.size } });
                    }
                    case 'labelrenderer':
                        res.setHeader({ name: 'Content-Type', value: 'application/javascript; charset=UTF-8' });
                        res.setHeader({ name: 'Cache-Control', value: 'private, max-age=3600' });
                        return res.write({ output: file.load({ id: './wh_zpl_renderer.js' }).getContents() });
                    case 'labelworker': {
                        const rendererUrl = file.load({ id: './wh_zpl_renderer.js' }).url;
                        res.setHeader({ name: 'Content-Type', value: 'application/javascript; charset=UTF-8' });
                        return res.write({ output: 'import { ready } from ' + JSON.stringify(rendererUrl) + ';' +
                            'self.onmessage = async (event) => { try {' +
                            'const {api} = await ready;' +
                            'const images = await api.zplToBase64MultipleAsync(event.data.zpl,101.6,152.4,8,{enableInvertedLabels:true});' +
                            'self.postMessage({images});' +
                            '} catch(e) { self.postMessage({error:String(e.message || e)}); } };' });
                    }
                    case 'data':      return boardWithDiag(res);
                    case 'diag':      return json(res, { ok: true, result: lib.diagnose().filter((d) => !d.ok) });
                    case 'stockcheck': return json(res, { ok: true, result: lib.stockCheck(p.so) });
                    case 'sostock':   return json(res, { ok: true, result: lib.getOrderStock(p.so) });
                    case 'ifdetail':  return json(res, { ok: true, result: lib.getFulfillmentDetail(p.ifid) });
                    case 'ticketpdf': return res.writeFile({ file: lib.buildPickTickets(p.ids), isInline: true });
                    case 'packslip':  return res.writeFile({ file: lib.packingSlip(p.so, p.if), isInline: true });
                    default:          return json(res, { ok: false, error: 'Unknown action' });
                }
            }

            let body = {};
            try { body = JSON.parse(req.body || '{}'); } catch (e) { body = {}; }
            const action = body.action || p.action;
            const fn = POST_ACTIONS[action];
            if (!fn) return json(res, { ok: false, error: 'Unknown action' });
            return json(res, { ok: true, result: fn(body, req) });

        } catch (e) {
            log.error({ title: `WH console ${req.method} ${p.action || ''}`, details: e });
            const msg = e.message || String(e);
            if (req.method === 'GET' && (p.action === 'ticketpdf' || p.action === 'packslip')) {
                res.write({ output: `<p style="font:14px sans-serif;padding:20px">${String(msg).replace(/</g, '&lt;')}</p>` });
                return;
            }
            return json(res, { ok: false, error: msg });
        }
    }

    // Keep errors fast; the explicit diag action is available for investigation.
    function boardWithDiag(res) {
        try {
            return json(res, { ok: true, result: lib.getBoard() });
        } catch (e) {
            log.error({ title: 'WH console board', details: e });
            return json(res, { ok: false, error: e.message || String(e) });
        }
    }

    function renderPage(res) {
        const script = runtime.getCurrentScript();
        const cfg = {
            url: url.resolveScript({ scriptId: script.id, deploymentId: script.deploymentId }),
            soUrl: '/app/accounting/transactions/salesord.nl?id=',
            ifUrl: '/app/accounting/transactions/itemship.nl?id=',
            poUrl: '/app/accounting/transactions/purchord.nl?id=',
            canRelease: lib.canRelease()
        };
        const safeCfg = JSON.stringify(cfg).replace(/<\/script>/gi, '<\\/script>');

        const form = serverWidget.createForm({ title: 'Shipping Console' });
        const fld = form.addField({ id: 'custpage_whc', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
        fld.defaultValue =
            `<style>${CSS}</style>` +
            MARKUP +
            `<script type="application/json" id="whc-config">${safeCfg}</script>` +
            `<script>(${clientMain.toString()})();</script>`;
        res.writePage(form);
    }

    /* ================================================================== */
    /*  Page markup + styles                                               */
    /* ================================================================== */

    const MARKUP = [
        '<div id="whc">',
        '  <div class="whc-rail" id="whc-rail" role="tablist"></div>',
        '  <section class="whc-panel">',
        '    <div class="whc-toolbar" id="whc-toolbar"></div>',
        '    <div id="whc-list"><div class="whc-empty">Loading…</div></div>',
        '  </section>',
        '  <dialog id="whc-overlay" aria-labelledby="whc-dtitle"><div id="whc-drawer">',
        '    <div class="whc-dh"><div><h2 id="whc-dtitle"></h2><div class="whc-sub" id="whc-dsub"></div></div>',
        '      <button type="button" class="whc-btn" data-act="close">Close</button></div>',
        '    <div id="whc-derror"></div>',
        '    <div class="whc-db" id="whc-dbody"></div>',
        '    <div class="whc-df" id="whc-dfoot"></div>',
        '  </div></dialog>',
        '  <div id="whc-toast" role="status"></div>',
        '</div>'
    ].join('');

    const CSS = `
#div__body{padding-top:0!important}
#custpage_whc_fs{margin:0!important;padding:0!important;width:100%!important}
#whc{--ink:#202b3a;--muted:#758091;--line:#e2e6ec;--bg2:#f7f8fa;--accent:#285f9d;--warn-bg:#fff7e6;--warn-ink:#8a621a;--ok-bg:#edf6f0;--ok-ink:#427356;--bad-bg:#fcf0f0;--bad-ink:#a55050;font:13px/1.5 Arial,Helvetica,sans-serif;color:var(--ink);box-sizing:border-box;width:100%;max-width:none;margin:0;padding:10px 12px 20px;font-variant-numeric:tabular-nums}
#whc *{box-sizing:border-box}
#whc button,#whc input,#whc select{font:inherit;color:inherit}
#whc a{color:var(--accent);text-decoration:none}#whc a:hover{text-decoration:underline}
#whc .whc-rail{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:10px;overflow-x:auto}
#whc .whc-stage{display:flex;align-items:center;justify-content:center;gap:10px;border:0;border-bottom:2px solid transparent;background:transparent;padding:9px 14px;color:var(--muted);cursor:pointer;white-space:nowrap}
#whc .whc-stage .t{font-weight:600}#whc .whc-stage .n{font-size:11px;min-width:23px;text-align:center;border-radius:5px;padding:1px 6px;background:#eef0f3;color:#667181}
#whc .whc-stage[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}#whc .whc-stage[aria-selected="true"] .n{background:#e8f0fa;color:var(--accent)}
#whc .whc-panel{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}
#whc .whc-toolbar{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#whc .whc-toolbar input,#whc .whc-toolbar select{border:1px solid var(--line);border-radius:5px;padding:8px 10px;background:#fff;height:36px}
#whc .whc-toolbar input{width:260px;max-width:100%;min-width:150px}#whc .whc-toolbar select{max-width:220px}#whc .whc-sp{flex:1}#whc #whc-bulk{display:flex;gap:8px;flex-wrap:wrap}
#whc .whc-btn{border:1px solid #d5dce5;background:#fff;border-radius:5px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;white-space:nowrap;line-height:18px}
#whc .whc-btn:hover:not(:disabled){background:#f3f6fa;border-color:#abb9ca}#whc .whc-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}#whc .whc-btn.primary:hover:not(:disabled){background:#214f84}
#whc .whc-btn.link{border-color:transparent;background:transparent;color:var(--muted)}#whc .whc-btn:disabled{opacity:.4;cursor:not-allowed}
#whc .whc-tw{overflow-x:auto}#whc table.whc-t{border-collapse:collapse;width:100%}
#whc .whc-t th{text-align:left;font-size:11px;font-weight:600;color:#677487;background:var(--bg2);padding:11px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
#whc .whc-t td{padding:10px 12px;border-bottom:1px solid #edf0f3;vertical-align:middle}#whc .whc-t tbody tr:last-child td{border-bottom:0}
#whc .whc-t tbody tr.dr{cursor:pointer}#whc .whc-t tbody tr.dr:hover td{background:#f8fafc}#whc .whc-t tbody tr.sel td{background:#f0f5fb}#whc .whc-t .cb{width:40px;padding-right:4px}
#whc input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;vertical-align:middle}
#whc .whc-sub{color:var(--muted);font-size:11px;margin-top:3px}#whc .whc-mono{font-family:Menlo,Consolas,monospace;font-size:12px}#whc .whc-empty{padding:64px 20px;text-align:center;color:var(--muted)}
#whc .pill{display:inline-block;border-radius:4px;padding:3px 7px;font-size:11px;font-weight:500;white-space:nowrap}#whc .pill.ok{background:var(--ok-bg);color:var(--ok-ink)}#whc .pill.warn{background:var(--warn-bg);color:var(--warn-ink)}#whc .pill.bad{background:var(--bad-bg);color:var(--bad-ink)}#whc .pill.no{background:#f1f3f6;color:#7b8592}
#whc #whc-overlay{display:none;position:fixed;inset:0;background:rgba(23,34,50,.3);z-index:2000;justify-content:flex-end}#whc #whc-overlay.open{display:flex}
#whc #whc-drawer{width:min(700px,100%);height:100vh;background:#fff;display:flex;flex-direction:column;box-shadow:-8px 0 32px rgba(20,30,45,.12)}
#whc .whc-dh{display:flex;gap:16px;align-items:center;padding:22px 24px;border-bottom:1px solid var(--line)}#whc .whc-dh h2{margin:0;font-size:21px;font-weight:600}#whc .whc-dh .whc-btn{margin-left:auto}
#whc #whc-derror:not(:empty){padding:12px 24px 0;max-height:35vh;overflow:auto;flex-shrink:0}#whc #whc-derror .whc-banner{margin:0}
#whc .whc-db{flex:1;overflow:auto;padding:24px;min-height:0}#whc .whc-df{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:16px 24px;border-top:1px solid var(--line);background:#fafbfc}
#whc .whc-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 24px;margin:4px 0 28px}#whc .whc-kv>div{overflow-wrap:anywhere}#whc .whc-kv span{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}
#whc .whc-banner{border-radius:5px;padding:10px 12px;margin-bottom:22px;font-size:12px}#whc .whc-banner.warn{background:var(--warn-bg);color:var(--warn-ink)}#whc .whc-banner.ok{background:var(--ok-bg);color:var(--ok-ink)}#whc .whc-banner.bad{background:var(--bad-bg);color:var(--bad-ink)}
#whc h3{font-size:13px;font-weight:600;margin:24px 0 12px}#whc .whc-lines th,#whc .whc-lines td{padding:10px}#whc .whc-lines input[type=number]{width:72px;border:1px solid var(--line);border-radius:4px;padding:6px}#whc .whc-lines tr.ds td{color:var(--muted)}
#whc .whc-pkg{display:grid;grid-template-columns:20px 110px 1fr 32px;gap:8px;align-items:center;margin-bottom:10px}#whc .whc-pkg input{border:1px solid var(--line);border-radius:5px;padding:9px;width:100%;min-width:0}
#whc #whc-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2100;display:none;background:var(--ink);color:#fff;padding:12px 20px;border-radius:6px;max-width:90%;box-shadow:0 4px 20px #0002}#whc #whc-toast.show{display:block}#whc #whc-toast.err{background:#a43b3b}
#whc :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:760px){#whc{padding:12px 8px}#whc .whc-stage{padding:12px 10px;gap:6px}#whc .whc-toolbar{padding:12px}#whc .whc-toolbar input{width:100%;flex-basis:100%}#whc .whc-sp{display:none}#whc #whc-bulk{margin-left:auto}#whc .whc-db{padding:16px}#whc .whc-dh{padding:16px}#whc .whc-df{padding:12px 16px}#whc .whc-pkg{grid-template-columns:18px 85px 1fr 28px}}
#whc{--accent:#126964;--bg2:#eef5f5;--muted:#526878}
#whc .whc-rail{gap:4px;padding:5px;background:#eaf2f3;border:1px solid #d6e4e5;border-radius:12px;width:fit-content;max-width:100%}
#whc .whc-stage{border:0;border-radius:8px}#whc .whc-stage[aria-selected=true]{background:#135951;color:white}#whc .whc-stage[aria-selected=true] .n{background:#d9f1e9;color:#15594f}
#whc .whc-panel{border-radius:12px}#whc .whc-toolbar{padding:14px;background:#f8fbfb}
#whc #whc-overlay{position:fixed;inset:0;margin:auto;padding:0;border:0;width:min(1080px,96vw);max-width:96vw;height:fit-content;max-height:90vh;background:white;border-radius:15px;box-shadow:0 18px 85px #10374455}
#whc #whc-overlay[open]{display:block}#whc #whc-overlay::backdrop{background:#16303d77}
#whc #whc-drawer{width:100%;height:auto;max-height:90vh;box-shadow:none}
#whc .whc-dh{background:#e8f4f0;border-top:4px solid #187968}#whc .whc-kv{padding:14px 18px;background:#f6f9fa;border-radius:8px;gap:10px 20px}
#whc .whc-dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
#whc .whc-dims label{text-transform:capitalize;font-weight:600;color:#324e5b}#whc .whc-dims input{display:block;width:100%;padding:8px;margin-top:4px;border:1px solid #bfcfd2;border-radius:5px}
#whc h3 small{font-weight:400;color:#526878}#whc-progress{padding:10px 16px;background:#e0f3ed;color:#124e43;font-weight:600}#whc-progress progress{display:block;width:100%;height:5px;accent-color:#107667;margin-top:4px}
#whc .whc-rel td{white-space:nowrap}#whc .whc-rel td.item{white-space:normal;min-width:180px}
#whc .whc-rel .ctl{display:flex;align-items:center;gap:6px}#whc .whc-rel .ctl input[type=number]{width:70px}
#whc .whc-rel th.grp{background:#e3efee;color:#174f49;text-align:center}
#whc .whc-rel td.short{color:var(--bad-ink);font-weight:600}
#whc #whc-relerr:not(:empty){margin-top:12px}#whc .whc-rel select{border:1px solid var(--line);border-radius:4px;padding:5px;max-width:180px;background:#fff}#whc .whc-status{display:flex;gap:14px;align-items:center;flex-wrap:wrap}#whc .whc-status select{margin-left:6px;border:1px solid #d9c38f;border-radius:4px;padding:5px}#whc #whc-relerr:empty{display:none}
`;

    /* ================================================================== */
    /*  Client code (serialized with toString; runs in the browser)        */
    /* ================================================================== */

    function clientMain() {
        'use strict';
        const CFG = JSON.parse(document.getElementById('whc-config').textContent);
        const STAGES = [
            { id: 'release', t: 'Release',       s: 'Approve, choose warehouse, release or PO' },
            { id: 'dropship', t: 'Drop Ship',    s: 'PO created, not yet delivered' },
            { id: 'ready',   t: 'Ready to Pick', s: 'Released, not yet picked' },
            { id: 'picked',  t: 'Picked',        s: 'Fulfillment status Picked' },
            { id: 'packed',  t: 'Packed',        s: 'Boxed and weighed, needs label' },
            { id: 'shipped', t: 'Shipped',       s: 'Recently shipped' }
        ];
        const VISIBLE = STAGES.filter((s) => CFG.canRelease || (s.id !== 'release' && s.id !== 'dropship'));
        const ORDER_TABS = { release: 1, ready: 1, dropship: 1 };
        const S = { costs: {}, tab: VISIBLE[0].id, board: null, sel: new Set(), q: '', ch: 'all', cm: 'all', st: 'all', od: 'all', relApprove: false, drawer: null, detail: null, pick: {}, rel: {}, pkgs: [], dims: {}, workflow: 'all', busy: false };
        const root = document.getElementById('whc');
        const $ = (id) => document.getElementById(id);
        const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
        const qtyFmt = (v) => (v === null || v === undefined || v === '') ? '\u2013' : Number(v).toLocaleString();

        /* ---------- server ---------- */
        function progress(message) {
            let box = $('whc-progress');
            if (!message) { if (box) box.remove(); return; }
            if (!box) {
                box = document.createElement('div'); box.id = 'whc-progress'; box.setAttribute('role', 'status');
                box.innerHTML = '<span></span><progress aria-label="Working"></progress>';
            }
            const host = root.querySelector('dialog[open]:last-of-type:not(#whc-overlay)') || (S.drawer ? $('whc-drawer') : root);
            host.prepend(box); box.firstChild.textContent = message;
        }
        function api(method, action, body, qs) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 120000);
            const opt = { method, credentials: 'same-origin', headers: {}, signal: controller.signal };
            if (method === 'POST') {
                progress(({ release: 'Releasing orders', releaseLines: 'Releasing lines and creating POs', unrelease: 'Returning order to Release', pick: 'Saving picked quantities', pack: 'Saving and checking packages', markPrinted: 'Saving ticket status', shippingCost: 'Requesting and saving shipping cost', label: 'Retrieving shipping labels', labelDownloaded: 'Saving label status', ship: 'Marking shipments shipped' })[action] + '…');
                opt.headers['Content-Type'] = 'application/json';
                opt.body = JSON.stringify(Object.assign({ action }, body || {}));
            }
            return fetch(CFG.url + '&action=' + encodeURIComponent(action) + (qs || ''), opt)
                .then((r) => { if (!r.ok) throw new Error('Server returned HTTP ' + r.status); return r.json(); })
                .then((j) => { if (!j.ok) throw new Error(j.error || 'Request failed'); return j.result; })
                .catch((e) => {
                    if (e.name === 'AbortError') throw new Error(method === 'POST'
                        ? 'The response timed out. The change may have saved. Refresh and check the record before trying again.'
                        : 'Loading timed out. Refresh to try again.');
                    throw e;
                }).finally(() => clearTimeout(timer));
        }

        function load(keepDrawer) {
            if (S.busy) progress('Refreshing orders…');
            return api('GET', 'data').then((b) => {
                S.board = b; S.costs = {};
                if (!keepDrawer) closeDrawer();
                render();
            }).catch((e) => {
                showError('Could not load orders: ' + e.message);
            });
        }

        function act(action, body, okMsg) {
            if (S.busy) return Promise.resolve();
            S.busy = true; renderBusy();
            return api('POST', action, body)
                .then((r) => {
                    if (r.skipped && r.skipped.length) {
                        const keep = S.drawer;
                        const msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
                        return load(true).then(() => keep ? openDrawer(keep) : null).then(() => {
                            if (msg) toast(msg);
                            showError(r.skipped.map((item) => item.reason || 'Action skipped.').join(' '));
                        });
                    }
                    toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return load();
                })
                .catch((e) => toast(e.message, true))
                .finally(() => { S.busy = false; renderBusy(); });
        }

        function showError(msg) {
            const target = S.drawer ? $('whc-derror') : root;
            const previous = target.querySelector('[data-whc-error]');
            if (previous) previous.remove();
            const message = document.createElement('div');
            message.dataset.whcError = '1'; message.className = 'whc-banner bad';
            message.setAttribute('role', 'alert'); message.textContent = msg + ' ';
            const dismiss = document.createElement('button'); dismiss.type = 'button';
            dismiss.className = 'whc-btn'; dismiss.textContent = 'Dismiss';
            dismiss.onclick = () => message.remove(); message.appendChild(dismiss);
            target.prepend(message);
        }

        function costCell(row) {
            const value = S.costs[String(row.ifId)];
            if (!value || value.loading) return '…';
            if (value.error) return '<span title="' + esc(value.error) + '">Unavailable</span>';
            return value.cost === null ? '—' : Number(value.cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        async function loadVisibleCosts(list) {
            const ids = list.map((r) => String(r.ifId)).filter((id) => !S.costs[id]);
            if (!ids.length) return;
            const costs = S.costs;
            ids.forEach((id) => { costs[id] = { loading: true }; });
            for (let i = 0; i < ids.length; i += 25) {
                const batch = ids.slice(i, i + 25);
                try {
                    const values = await api('GET', 'shippingcosts', null, '&ifids=' + batch.join(','));
                    if (S.costs !== costs) return;
                    values.forEach((value) => { costs[String(value.ifId)] = value; });
                    const failed = values.filter((value) => value.error);
                    if (failed.length) showError('Could not load shipping cost for IF ' + failed.map((value) => value.ifId).join(', ') + ': ' + failed[0].error);
                    batch.forEach((id) => { if (costs[id].loading) costs[id] = { error: 'Cost was not returned.' }; });
                } catch (e) {
                    if (S.costs !== costs) return;
                    batch.forEach((id) => { costs[id] = { error: e.message }; });
                    showError('Could not load shipping costs: ' + e.message);
                }
                if (S.tab === 'packed' || S.tab === 'shipped') renderList();
            }
        }

        let localRendererModule;
        function previewTimeout(promise, message) {
            let timer;
            return Promise.race([promise, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), 60000);
            })]).finally(() => clearTimeout(timer));
        }

        function renderInWorker(zpl) {
            return new Promise((resolve, reject) => {
                let worker, timer, finished = false;
                const finish = (error, images) => {
                    if (finished) return;
                    finished = true; clearTimeout(timer);
                    if (worker) worker.terminate();
                    if (error) reject(error); else resolve(images);
                };
                try {
                    worker = new Worker(CFG.url + '&action=labelworker&v=2', { type: 'module' });
                    timer = setTimeout(() => finish(new Error('Preview worker timed out.')), 60000);
                    worker.onerror = (event) => {
                        event.preventDefault();
                        finish(new Error(event.message || 'Browser could not load the preview worker.'));
                    };
                    worker.onmessage = (event) => {
                        if (event.data.error) finish(new Error(event.data.error));
                        else finish(null, event.data.images);
                    };
                    worker.postMessage({ zpl });
                } catch (e) { finish(e); }
            });
        }

        async function renderLocalLabel(zpl) {
            // Resolve the real File Cabinet URL first, so a missing asset is
            // reported separately from module-worker or WebAssembly failures.
            let info;
            try { info = await api('GET', 'labelrendererinfo'); }
            catch (e) { throw new Error('Renderer file could not be loaded: ' + e.message); }
            const rendererUrl = new URL(info.url, window.location.href);
            if (rendererUrl.origin !== window.location.origin) {
                throw new Error('Renderer must be served from this NetSuite account.');
            }
            try { return await renderInWorker(zpl); }
            catch (workerError) {
                // Some account/browser configurations reject module workers
                // served by Suitelets. The same engine can run locally on the
                // page instead, without changing CSP or sending label data out.
                try {
                    if (!localRendererModule) {
                        rendererUrl.searchParams.set('whc_renderer_version', '2');
                        localRendererModule = previewTimeout(import(rendererUrl.href), 'Renderer file loading timed out.')
                            .catch((e) => { localRendererModule = null; throw e; });
                    }
                    const module = await localRendererModule;
                    const loaded = await previewTimeout(module.ready, 'Local renderer initialization timed out.');
                    return await previewTimeout(loaded.api.zplToBase64MultipleAsync(zpl, 101.6, 152.4, 8,
                        { enableInvertedLabels: true }), 'Label rendering timed out.');
                } catch (e) {
                    throw new Error('Local preview failed: ' + e.message +
                        ' Worker: ' + workerError.message + '. Copy and Download ZPL are still available.');
                }
            }
        }

        function toast(msg, err) {
            if (err) { showError(msg); return; }
            const t = $('whc-toast');
            t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
            clearTimeout(toast.h); toast.h = setTimeout(() => { t.className = ''; }, err ? 6000 : 3200);
        }

        function renderBusy() {
            if (!S.busy) progress('');
            root.querySelectorAll('[data-busy]').forEach((b) => { b.disabled = S.busy || b.dataset.busy === 'off'; });
        }

        /* ---------- data helpers ---------- */
        const keyOf = (r) => String(r.ifId || r.id);
        const findRow = (k) => {
            const b = S.board; if (!b) return null;
            const order = [S.tab].concat(STAGES.map((s) => s.id).filter((id) => id !== S.tab));
            for (const id of order) { const r = (b[id] || []).find((x) => keyOf(x) === String(k)); if (r) return { row: r, stage: id }; }
            return null;
        };
        function commitPill(c) {
            if (c === 'full') return '<span class="pill ok">In stock</span>';
            if (c === 'partial') return '<span class="pill warn">Partial stock</span>';
            return '<span class="pill bad">No stock</span>';
        }
        function dsNote(o) {
            let h = '';
            if (o.awaitingPo) h += '<div class="whc-sub">' + plural(o.awaitingPo, 'dropship line') + ' awaiting PO</div>';
            return h;
        }
        const axes = ['length', 'width', 'height'];
        function newBox() { return { weight: '', descr: '', dimensions: {} }; }
        function resetBox() { S.box = newBox(); S.editBox = -1; S.boxDirty = false; }
        function validBox(p) { return Number(p.weight) > 0 && (S.detail.packageSublist !== 'packagefedex' || axes.every(k => Number((p.dimensions || {})[k]) > 0)); }
        function packReady() { return !S.boxDirty && S.pkgs.length && S.pkgs.every(validBox); }
        function boxList(packages, edit) {
            if (!packages.length) return '';
            return '<div class="whc-tw"><table class="whc-t"><thead><tr><th>Box</th><th>Weight</th><th>Dimensions (L × W × H)</th>' + (edit ? '<th></th>' : '') + '</tr></thead><tbody>' + packages.map((p, i) =>
                '<tr><td>' + (i + 1) + '</td><td>' + esc(p.weight) + ' lb</td><td>' + (axes.every(k => Number((p.dimensions || {})[k]) > 0) ? axes.map(k => esc(p.dimensions[k])).join(' × ') + ' in' : '—') + '</td>' + (edit ? '<td><button type="button" class="whc-btn" data-act="editPkg" data-i="' + i + '">Edit box ' + (i + 1) + '</button> <button type="button" class="whc-btn link" data-act="rmPkg" data-i="' + i + '">Remove</button></td>' : '') + '</tr>').join('') + '</tbody></table></div>';
        }
        function rows() {
            const q = S.q.trim().toLowerCase();
            return (S.board[S.tab] || [])
                .filter((r) => S.ch === 'all' || r.channel === S.ch)
                .filter((r) => S.tab !== 'release' || S.cm === 'all' || r.relCommit === S.cm)
                .filter((r) => S.tab !== 'release' || S.st === 'all' || (S.st === 'pending') === !!r.pending)
                .filter(r => S.workflow === 'all' || (S.tab === 'packed' ? !!r.labelPrinted : !!r.printed) === (S.workflow === 'yes'))
                .filter((r) => S.tab !== 'dropship' || S.od === 'all' || (S.od === 'late') === !!r.overdue)
                .filter((r) => !q || [r.tranid, r.soNum, r.ifNum, r.customer, r.channel].concat(r.pos || [], r.vendors || []).join(' ').toLowerCase().indexOf(q) > -1);
        }

        /* ---------- release (line level, on hand / available; no commitment) ---------- */
        function lineStock(l, loc) {
            const s = (l.stock || {})[loc];
            return s || { onHand: null, available: null };
        }

        // Merge stock read from the SO lines and the item Locations subtab into the release lines
        function applyOrderStock(r, d) {
            r.lines.forEach((l) => {
                const it = (d.items || {})[String(l.itemId)];
                if (it && Object.keys(it).length) {
                    const all = Object.values(it);
                    l.stock = Object.assign({}, it, {
                        '': { onHand: all.reduce((a, v) => a + v.onHand, 0), available: all.reduce((a, v) => a + v.available, 0) }
                    });
                }
                const sl = (d.lines || {})[String(l.lineId)];
                if (sl && sl.onHand !== null) {
                    l.stock = l.stock || {};
                    l.stock[sl.loc] = { onHand: sl.onHand, available: sl.available === null ? sl.onHand : sl.available };
                }
            });
            let have = 0;
            r.lines.forEach((l) => {
                if (l.dropship || !(l.unreleased > 0)) return;
                const av = lineStock(l, l.defaultLoc || '').available;
                have += Math.min(l.unreleased, Math.max(0, Number(av) || 0));
            });
            r.relReady = have;
            r.relCommit = have === 0 ? 'none' : (have < r.relUnits ? 'partial' : 'full');
        }

        function initRelease(r) {
            S.rel = {}; S.relApprove = !!r.pending;
            r.lines.forEach((l) => {
                if (l.dropship || !(l.unreleased > 0)) return;
                const loc = l.defaultLoc || '';
                const av = lineStock(l, loc).available;
                const rq = av === null ? l.unreleased : Math.max(0, Math.min(l.unreleased, av));
                S.rel[l.lineId] = { loc, r: rq > 0, rq: rq || l.unreleased, d: false };
            });
        }

        function relCheck(r) {
            const lines = []; let sumR = 0, sumD = 0, error = '', warn = '';
            r.lines.forEach((l) => {
                const s = S.rel[l.lineId]; if (!s) return;
                const po = !!s.d;
                const rq = s.r && !po ? Number(s.rq) : 0;
                const locChanged = !!s.loc && s.loc !== (l.locId || '');
                if (!rq && !po && !locChanged) return;
                if (error) return;
                if (!Number.isFinite(rq) || rq < 0) error = l.sku + ': enter a positive quantity.';
                else if (rq > l.unreleased) error = l.sku + ': only ' + l.unreleased + ' open and not released.';
                else if (rq && !s.loc) error = l.sku + ': choose a location to release to.';
                else if (po && l.hasPo) error = l.sku + ': this line already has a PO.';
                else if (po && !r.pending && !warn) warn = 'Approved order: Create PO only works on lines NetSuite already marked Drop Ship / Special Order.';
                const av = lineStock(l, s.loc).available;
                if (rq && av !== null && rq > av && !warn) warn = l.sku + ': releasing ' + rq + ' but only ' + av + ' available at this location.';
                lines.push({ lineId: l.lineId, location: s.loc, releaseQty: rq, createPo: po });
                sumR += rq; sumD += po ? 1 : 0;
            });
            if (!error && r.pending && (sumR || sumD) && !S.relApprove) error = 'Set the status to Pending Fulfillment to release lines or create POs.';
            const approveOnly = r.pending && S.relApprove && !lines.length;
            let label = sumR && sumD ? 'Release & create PO' : sumD ? 'Create PO' : sumR ? 'Release to warehouse' : 'Save';
            if (r.pending && S.relApprove) label = 'Approve' + (sumR || sumD ? ' & ' + label.toLowerCase() : '');
            return { ok: !error && (lines.length > 0 || approveOnly), error, warn, lines, label, sumR, sumD };
        }

        function refreshRelease() {
            const f = findRow(S.drawer); if (!f || f.stage !== 'release') return;
            const v = relCheck(f.row);
            const btn = root.querySelector('[data-act="applyRelease"]');
            if (btn) { btn.dataset.busy = v.ok ? 'on' : 'off'; btn.textContent = v.label; }
            const box = $('whc-relerr');
            if (box) { box.textContent = v.error || v.warn || ''; box.className = 'whc-banner ' + (v.error ? 'bad' : 'warn'); }
            renderBusy();
        }

        /* ---------- list ---------- */
        function render() {
            const b = S.board;
            if (!VISIBLE.some((s) => s.id === S.tab)) S.tab = VISIBLE[0].id;
            $('whc-rail').innerHTML = VISIBLE.map((s) =>
                '<button type="button" role="tab" class="whc-stage" data-s="' + s.id + '" data-act="tab" data-k="' + s.id + '" aria-selected="' + (S.tab === s.id) + '">' +
                '<span class="t">' + s.t + '</span><span class="n">' + (b[s.id] || []).length + '</span></button>'
            ).join('');
            renderToolbar();
            renderList();
            renderBusy();
        }

        function renderToolbar() {
            const t = S.tab;
            const opt = (v, cur, label) => '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>';
            let h = '<input type="search" data-chg="q" placeholder="Search orders or customers" value="' + esc(S.q) + '" aria-label="Search">' +
                '<select data-chg="ch" aria-label="Channel">' + opt('all', S.ch, 'All channels') + S.board.channels.map((c) => opt(c, S.ch, c)).join('') + '</select>';
            if (t === 'release') {
                h += '<select data-chg="st" aria-label="Order status">' + opt('all', S.st, 'All statuses') + opt('pending', S.st, 'Pending Approval') + opt('approved', S.st, 'Approved') + '</select>' +
                    '<select data-chg="cm" aria-label="Stock">' + opt('all', S.cm, 'Any stock') + opt('full', S.cm, 'In stock') +
                    opt('partial', S.cm, 'Partial stock') + opt('none', S.cm, 'No stock') + '</select>';
            }
            if (t === 'dropship') h += '<select data-chg="od" aria-label="Due">' + opt('all', S.od, 'All POs') + opt('late', S.od, 'Past receive-by date') + opt('ontime', S.od, 'Not yet due') + '</select>';
            if (t === 'packed' || t === 'ready') h += '<select aria-label="Workflow status" data-chg="workflow">' + opt('all', S.workflow, 'All statuses') + opt('yes', S.workflow, t === 'packed' ? 'Label ready' : 'Ticket printed') + opt('no', S.workflow, t === 'packed' ? 'Needs label' : 'Needs ticket') + '</select>';
            h += '<span class="whc-sp"></span><button type="button" class="whc-btn" data-act="refresh">Refresh</button><span id="whc-bulk"></span>';
            $('whc-toolbar').innerHTML = h;
            renderBulk();
        }

        function selected() {
            const vis = new Set(rows().map(keyOf));
            return [...S.sel].filter((k) => vis.has(k));
        }

        function renderBulk() {
            const sel = selected(), t = S.tab;
            let h = '';
            if (t === 'release') {
                const n = sel.filter((k) => !findRow(k).row.blocked).length;
                h = '<button type="button" class="whc-btn primary" data-act="releaseSel" data-busy="' + (n ? 'on' : 'off') + '" title="Approves Pending Approval orders and releases all open qty">Approve & release all' + (n ? ' (' + n + ')' : '') + '</button>';
            } else if (t === 'ready') {
                h = '<button type="button" class="whc-btn primary" data-act="ticketsSel" data-busy="' + (sel.length ? 'on' : 'off') + '">Print tickets' + (sel.length ? ' (' + sel.length + ')' : '') + '</button>';
            } else if (t === 'packed') {
                const n = sel.filter((k) => findRow(k).row.labelPrinted).length;
                h = '<button type="button" class="whc-btn" data-act="labelsSel" data-busy="' + (sel.length ? 'on' : 'off') + '">Print labels' + (sel.length ? ' (' + sel.length + ')' : '') + '</button> ' +
                    '<button type="button" class="whc-btn primary" data-act="shipSel" data-busy="' + (n ? 'on' : 'off') + '">Mark shipped' + (n ? ' (' + n + ')' : '') + '</button>';
            }
            $('whc-bulk').innerHTML = h;
            renderBusy();
        }

        function renderList() {
            const t = S.tab, list = rows();
            const hasCb = t === 'release' || t === 'ready' || t === 'packed';
            const head = {
                release: ['Order', 'Channel', 'Date', 'Customer', 'Ship via', 'To release', 'Stock'],
                dropship: ['Order', 'Channel', 'Customer', 'PO', 'Vendor', 'Pending', 'PO age', 'Receive by'],
                ready:   ['Order', 'Channel', 'Released', 'Customer', 'Ship via', 'To pick', 'Picking ticket'],
                picked:  ['Fulfillment', 'Channel', 'Order', 'Customer', 'Ship via', 'Date', 'Lines'],
                packed:  ['Fulfillment', 'Channel', 'Order', 'Customer', 'Ship via', 'Shipping cost', 'Date', 'Label'],
                shipped: ['Fulfillment', 'Channel', 'Order', 'Customer', 'Ship via', 'Shipping cost', 'Shipped', 'Lines']
            }[t];
            if (!list.length) {
                $('whc-list').innerHTML = '<div class="whc-empty">' + ({
                    release: 'No open orders waiting for release.',
                    dropship: 'No drop ship POs waiting for delivery.',
                    ready: 'Nothing to pick. Orders appear here once a manager releases them.',
                    picked: 'No picked fulfillments waiting to be packed.',
                    packed: 'No packed fulfillments waiting for a label.',
                    shipped: 'Nothing shipped in the selected period.'
                })[t] + '</div>';
                return;
            }
            const allSel = hasCb && list.every((r) => S.sel.has(keyOf(r)));
            const body = list.map((r) => {
                const k = keyOf(r);
                let c = [];
                if (t === 'dropship') {
                    c = ['<strong>' + esc(r.tranid) + '</strong><div class="whc-sub">' + esc(r.status) + '</div>', esc(r.channel), esc(r.customer),
                        esc(r.pos.join(', ')), esc(r.vendors.join(', ')),
                        r.units + ' units, ' + plural(r.lines.length, 'line'),
                        r.daysOpen + ' days<div class="whc-sub">' + esc(r.oldestPo) + '</div>',
                        r.overdue ? '<span class="pill bad">Late ' + esc(r.receiveBy) + '</span>' : (r.receiveBy ? esc(r.receiveBy) : '\u2013')];
                } else if (t === 'release') {
                    c = ['<strong>' + esc(r.tranid) + '</strong><div class="whc-sub">' + (r.pending ? '<span class="pill warn">Pending Approval</span>' : esc(r.status)) + '</div>', esc(r.channel), esc(r.date), esc(r.customer), esc(r.shipVia),
                        plural(r.relLines, 'line') + ', ' + r.relUnits + ' units' + (r.releasedUnits ? '<div class="whc-sub">' + r.releasedUnits + ' already released</div>' : ''),
                        r.blocked ? '<span class="pill bad">' + esc(r.blocked) + '</span>' : commitPill(r.relCommit)];
                } else if (t === 'ready') {
                    c = ['<strong>' + esc(r.tranid) + '</strong><div class="whc-sub">' + esc(r.status) + '</div>', esc(r.channel),
                        esc(r.releasedOn) + '<div class="whc-sub">' + esc(r.releasedBy) + '</div>', esc(r.customer), esc(r.shipVia),
                        r.pickUnits + ' units, ' + plural(r.pickLines, 'line') + (r.commit === 'partial' ? '<div class="whc-sub">Partially released</div>' : '') + dsNote(r),
                        r.printed ? '<span class="pill warn">Printed ' + esc(r.printedOn) + ' by ' + esc(r.printedBy) + (r.printCount > 1 ? ' (x' + r.printCount + ')' : '') + '</span>' : '<span class="pill no">Not printed</span>'];
                } else {
                    const last = t === 'picked' ? plural(r.lines.length, 'line') + ', ' + r.units + ' units'
                        : t === 'packed' ? (r.labelPrinted ? '<span class="pill ok">Printed</span>' : '<span class="pill no">Not printed</span>')
                        : plural(r.lines.length, 'line') + ', ' + r.units + ' units';
                    c = ['<strong>' + esc(r.ifNum) + '</strong>', esc(r.channel), esc(r.soNum) + '<div class="whc-sub">' + esc(r.soStatus) + '</div>', esc(r.customer), esc(r.shipVia), esc(r.date), last];
                    if (t === 'packed' || t === 'shipped') c.splice(5, 0, costCell(r));
                }
                return '<tr class="dr' + (S.sel.has(k) ? ' sel' : '') + '" data-act="open" data-k="' + esc(k) + '">' +
                    (hasCb ? '<td class="cb" data-act="noop"><input type="checkbox" data-chg="sel" data-k="' + esc(k) + '"' + (S.sel.has(k) ? ' checked' : '') + ' aria-label="Select"></td>' : '') +
                    c.map((x) => '<td>' + x + '</td>').join('') + '</tr>';
            }).join('');
            $('whc-list').innerHTML = '<div class="whc-tw"><table class="whc-t"><thead><tr>' +
                (hasCb ? '<th class="cb"><input type="checkbox" data-chg="selAll"' + (allSel ? ' checked' : '') + ' aria-label="Select all"></th>' : '') +
                head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
            if (t === 'packed' || t === 'shipped') loadVisibleCosts(list);
        }

        /* ---------- drawer ---------- */
        function openDrawer(k) {
            const f = findRow(k); if (!f) return;
            S.drawer = k; S.detail = null; $('whc-derror').replaceChildren();
            if (f.stage === 'ready') {
                S.pick = {};
                f.row.lines.forEach((l) => { if (!l.dropship && l.committed > 0) S.pick[l.lineId] = { check: false, qty: l.committed }; });
            }
            if (f.stage === 'release') {
                initRelease(f.row);
                api('GET', 'sostock', null, '&so=' + encodeURIComponent(f.row.id)).then((d) => {
                    if (S.drawer !== k) return;
                    applyOrderStock(f.row, d);
                    initRelease(f.row);
                    renderDrawer();
                }).catch((e) => showError('Could not load stock: ' + e.message));
            }
            if (!$('whc-overlay').open) $('whc-overlay').showModal();
            renderDrawer();
            if (!ORDER_TABS[f.stage]) {
                return api('GET', 'ifdetail', null, '&ifid=' + encodeURIComponent(f.row.ifId)).then((d) => {
                    if (S.drawer !== k) return;
                    S.detail = d; resetBox();
                    S.pkgs = d.packages.filter(p => Number(p.weight) > 0 || p.tracking || p.descr || Object.values(p.dimensions || {}).some(Boolean));
                    if (S.pkgs.length === 1 && !validBox(S.pkgs[0])) { S.editBox = 0; S.box = JSON.parse(JSON.stringify(S.pkgs[0])); }
                    renderDrawer();
                }).catch((e) => toast(e.message, true));
            }
        }
        function closeDrawer() { S.drawer = null; S.detail = null; if ($('whc-overlay').open) $('whc-overlay').close(); }

        function kv(pairs) {
            return '<div class="whc-kv">' + pairs.filter((p) => p[1] !== undefined && p[1] !== '').map((p) => '<div><span>' + p[0] + '</span>' + p[1] + '</div>').join('') + '</div>';
        }

        function releaseBody(r) {
            const open = r.lines.filter((l) => !l.dropship && l.unreleased > 0);
            const other = r.lines.filter((l) => l.dropship || !(l.unreleased > 0));
            const v = relCheck(r);
            const locs = S.board.locations || [];
            const rowsHtml = open.map((l) => {
                const s = S.rel[l.lineId];
                const st = lineStock(l, s.loc);
                const want = s.r && !s.d ? (Number(s.rq) || 0) : l.unreleased;
                const short = st.available !== null && st.available < want;
                const locLocked = l.released > 0;
                const locSel = '<select data-chg="relLoc" data-line="' + esc(l.lineId) + '"' + (locLocked ? ' disabled' : '') + ' aria-label="Location ' + esc(l.sku) + '">' +
                    (s.loc ? '' : '<option value="">Choose… (all locations)</option>') +
                    locs.map((x) => {
                        const xs = (l.stock || {})[x.id];
                        return '<option value="' + esc(x.id) + '"' + (x.id === s.loc ? ' selected' : '') + '>' + esc(x.name) +
                            (xs ? ' \u2013 ' + xs.available + ' avail' : '') + '</option>';
                    }).join('') +
                    '</select>';
                return '<tr>' +
                    '<td class="item">' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td>' +
                    '<td>' + l.unreleased + (l.released ? '<div class="whc-sub">' + l.released + ' released</div>' : '') + '</td>' +
                    '<td>' + locSel + '</td>' +
                    '<td>' + qtyFmt(st.onHand) + '</td>' +
                    '<td' + (short ? ' class="short"' : '') + '>' + qtyFmt(st.available) + '</td>' +
                    '<td><div class="ctl"><input type="checkbox" data-chg="relChk" data-line="' + esc(l.lineId) + '"' + (s.r && !s.d ? ' checked' : '') + (s.d ? ' disabled' : '') + ' aria-label="Release ' + esc(l.sku) + '">' +
                        '<input type="number" min="0" step="any" max="' + l.unreleased + '" value="' + esc(s.rq) + '" data-chg="relQty" data-line="' + esc(l.lineId) + '"' + (s.r && !s.d ? '' : ' disabled') + ' aria-label="Release qty ' + esc(l.sku) + '"></div></td>' +
                    '<td><div class="ctl"><input type="checkbox" data-chg="dsChk" data-line="' + esc(l.lineId) + '"' + (s.d ? ' checked' : '') + (l.hasPo ? ' disabled' : '') + ' aria-label="Create PO for ' + esc(l.sku) + '">' +
                        '<span class="whc-sub">Drop ship, whole line</span></div>' +
                        '<div class="whc-sub">' + (l.vendor ? esc(l.vendor) : 'No vendor on item') + '</div></td>' +
                    '</tr>';
            }).join('');
            const otherHtml = other.map((l) =>
                '<tr class="ds"><td class="item">' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td><td colspan="6">' +
                (l.dropship ? 'PO ' + esc(l.po || '') + ' \u00b7 vendor ships'
                    : (l.remaining ? 'Fully released (' + l.released + ')' : 'Closed')) + '</td></tr>').join('');

            const info = kv([['Customer', esc(r.customer)], ['Channel', esc(r.channel)], ['Ship via', esc(r.shipVia)], ['Order date', esc(r.date)],
                ['Ship to', esc(r.shipTo).replace(/\r?\n/g, '<br>')]]);
            const statusCtl = r.pending
                ? '<div class="whc-banner warn whc-status"><strong>Pending Approval</strong>' +
                  '<label>Status <select data-chg="relApprove" aria-label="Order status">' +
                  '<option value="A"' + (S.relApprove ? '' : ' selected') + '>Pending Approval</option>' +
                  '<option value="B"' + (S.relApprove ? ' selected' : '') + '>Pending Fulfillment</option></select></label>' +
                  '<span>Approving saves the lines; NetSuite creates and links the PO for lines marked Create PO.</span></div>'
                : '';
            const banner = (r.blocked ? '<div class="whc-banner bad">' + esc(r.blocked) + '. Release is blocked; PO creation is still allowed unless the order is on hold.</div>' : '') +
                (!r.relUnits ? '<div class="whc-banner ok">Nothing left to release on this order.</div>'
                : r.relCommit === 'none' ? '<div class="whc-banner warn">No available stock at the selected locations. Create a PO or release what you have.</div>'
                : r.relCommit === 'partial' ? '<div class="whc-banner warn">Partial stock: ' + plural(r.relUnits - r.relReady, 'unit') + ' not available.</div>'
                : '<div class="whc-banner ok">All open qty is available.</div>');

            return {
                body: statusCtl + banner + info +
                    '<h3>Lines <small>Choose the warehouse, release qty for picking, or create a drop ship PO</small></h3>' +
                    '<div class="whc-tw"><table class="whc-t whc-lines whc-rel"><thead><tr><th>Item</th><th>Open</th><th>Location</th><th>On hand</th><th>Available</th>' +
                    '<th class="grp">Release to warehouse</th><th class="grp">Create PO</th></tr></thead><tbody>' + rowsHtml + otherHtml + '</tbody></table></div>' +
                    '<div id="whc-relerr" class="whc-banner ' + (v.error ? 'bad' : 'warn') + '" role="alert">' + esc(v.error || v.warn || '') + '</div>',
                foot: '<button type="button" class="whc-btn" data-act="relAll">Release all available</button>' +
                    '<button type="button" class="whc-btn primary" data-act="applyRelease" data-k="' + r.id + '" data-busy="' + (v.ok ? 'on' : 'off') + '">' + v.label + '</button>'
            };
        }

        function renderDrawer() {
            if (!S.drawer) return;
            const f = findRow(S.drawer);
            if (!f) { closeDrawer(); return; }
            const r = f.row, st = f.stage;
            let body = '', foot = '';

            if (ORDER_TABS[st]) {
                $('whc-dtitle').innerHTML = '<a href="' + CFG.soUrl + r.id + '" target="_blank" rel="noopener">' + esc(r.tranid) + '</a>';
                $('whc-dsub').textContent = STAGES.find((s) => s.id === st).t + ' \u2013 ' + r.status;
                const info = kv([['Customer', esc(r.customer)], ['Channel', esc(r.channel)], ['Ship via', esc(r.shipVia)], ['Order date', esc(r.date)],
                    ['Ship to', esc(r.shipTo).replace(/\r?\n/g, '<br>')]]);

                if (st === 'dropship') {
                    body = info + '<h3>Lines waiting on the vendor</h3><div class="whc-tw"><table class="whc-t whc-lines"><thead><tr>' +
                        '<th>Item</th><th>PO</th><th>Vendor</th><th>PO status</th><th>Ordered</th><th>Delivered</th><th>Pending</th><th>Receive by</th></tr></thead><tbody>' +
                        r.lines.map((l) => '<tr><td>' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td>' +
                            '<td><a href="' + CFG.poUrl + l.poId + '" target="_blank" rel="noopener">' + esc(l.poNum) + '</a><div class="whc-sub">' + esc(l.poDate) + ' \u00b7 ' + l.daysOpen + ' days</div></td>' +
                            '<td>' + esc(l.vendor) + '</td><td>' + esc(l.poStatus) + '</td><td>' + l.qty + '</td><td>' + l.delivered + '</td><td><strong>' + l.pending + '</strong></td>' +
                            '<td>' + (l.overdue ? '<span class="pill bad">Late ' + esc(l.poDue) + '</span>' : esc(l.poDue || '\u2013')) + '</td></tr>').join('') +
                        '</tbody></table></div>';
                    foot = '';
                } else if (st === 'release') {
                    const out = releaseBody(r);
                    body = out.body; foot = out.foot;
                } else {
                    const anyChecked = Object.values(S.pick).some((p) => p.check && Number(p.qty) > 0);
                    const dis = r.printed ? '' : ' disabled';
                    body = (r.printed
                        ? '<div class="whc-banner ok">Picking ticket printed ' + esc(r.printedOn) + ' by ' + esc(r.printedBy) + (r.printCount > 1 ? ', ' + r.printCount + ' times' : '') + '.</div>'
                        : '<div class="whc-banner warn">Print a ticket to begin picking.</div>') + info +
                        '<h3>Items to pick</h3><div class="whc-tw"><table class="whc-t whc-lines"><thead><tr><th>Picked</th><th>Bin</th><th>Item</th><th>Released</th><th>Qty picked</th></tr></thead><tbody>' +
                        r.lines.filter((l) => !l.dropship && l.remaining > 0).map((l) => {
                            const p = S.pick[l.lineId];
                            if (!p) return '<tr class="ds"><td>\u2013</td><td>' + esc(l.bin || '') + '</td><td>' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td><td colspan="2">Not released</td></tr>';
                            return '<tr><td><input type="checkbox" data-chg="pickChk" data-line="' + l.lineId + '"' + (p.check ? ' checked' : '') + dis + ' aria-label="Picked ' + esc(l.sku) + '"></td>' +
                                '<td class="whc-mono">' + esc(l.bin || '\u2013') + '</td><td>' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td>' +
                                '<td>' + l.committed + (l.committed < l.remaining ? '<div class="whc-sub">' + (l.remaining - l.committed) + ' not released</div>' : '') + '</td>' +
                                '<td><input type="number" min="1" max="' + l.committed + '" value="' + esc(p.qty) + '" data-chg="pickQty" data-line="' + l.lineId + '"' + dis + ' aria-label="Qty picked ' + esc(l.sku) + '"></td></tr>';
                        }).join('') +
                        r.lines.filter((l) => l.dropship && l.remaining > 0).map((l) =>
                            '<tr class="ds"><td>\u2013</td><td>\u2013</td><td>' + esc(l.name) + '<div class="whc-sub">' + esc(l.sku) + '</div></td><td colspan="2">' + (l.po ? 'Dropship, ' + esc(l.po) + ' · excluded' : 'Dropship · awaiting PO') + '</td></tr>'
                        ).join('') + '</tbody></table></div>';
                    foot = (r.printed || !CFG.canRelease ? '' : '<button type="button" class="whc-btn link" data-act="unrelease" data-k="' + r.id + '" data-busy="on">Return to release</button>') +
                        '<button type="button" class="whc-btn" data-act="ticketOne" data-k="' + r.id + '" data-busy="on">' + (r.printed ? 'Reprint ticket' : 'Print ticket') + '</button>' +
                        '<button type="button" class="whc-btn" data-act="checkAll" data-busy="' + (r.printed ? 'on' : 'off') + '">Select all</button>' +
                        '<button type="button" class="whc-btn primary" data-act="markPicked" data-k="' + r.id + '" data-busy="' + (r.printed && anyChecked ? 'on' : 'off') + '">Mark picked</button>';
                }
            } else {
                $('whc-dtitle').innerHTML = '<a href="' + CFG.ifUrl + r.ifId + '" target="_blank" rel="noopener">' + esc(r.ifNum) + '</a>';
                $('whc-dsub').innerHTML = STAGES.find((s) => s.id === st).t + ' \u2013 <a href="' + CFG.soUrl + r.soId + '" target="_blank" rel="noopener">' + esc(r.soNum) + '</a>';
                const d = S.detail;
                if (!d) {
                    body = '<div class="whc-empty">Loading…</div>';
                } else {
                    const info = kv([['Customer', esc(r.customer)], ['Channel', esc(r.channel)], ['Ship via', esc(d.shipVia)],
                        ['Shipping cost', d.shippingCost === '' || d.shippingCost == null ? 'Not calculated' : esc(d.shippingCost)],
                        ['Tracking', d.tracking.length ? '<span class="whc-mono">' + d.tracking.map(esc).join('<br>') + '</span>' : ''],
                        ['Ship to', esc(d.shipTo).replace(/\r?\n/g, '<br>')]]);
                    const lines = '<h3>Items</h3><div class="whc-tw"><table class="whc-t whc-lines"><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody>' +
                        d.lines.map((l) => '<tr><td>' + esc(l.sku) + '<div class="whc-sub">' + esc(l.name) + '</div></td><td>' + l.qty + '</td></tr>').join('') + '</tbody></table></div>';
                    const slip = '<button type="button" class="whc-btn" data-act="packSlip" data-k="' + r.ifId + '">Packing slip</button>';

                    if (st === 'picked') {
                        const ok = packReady();
                        const fields = ['weight'].concat(d.packageSublist === 'packagefedex' ? axes : ['descr']);
                        body = info + lines + '<h3>Packages</h3>' + boxList(S.pkgs, true) + '<h3>' + (S.editBox < 0 ? 'New box' : 'Edit box ' + (1 + S.editBox)) + '</h3><div class="whc-dims">' + fields.map(k => '<label>' + ({ weight: 'Weight (lb)', length: 'Length (in)', width: 'Width (in)', height: 'Height (in)', descr: 'Description' })[k] + '<input data-chg="box" data-f="' + k + '" type="' + (k === 'descr' ? 'text' : 'number') + '" step="any" min="0" value="' + esc(axes.includes(k) ? (S.box.dimensions || {})[k] : S.box[k]) + '"></label>').join('') + '</div><p><button type="button" class="whc-btn" data-act="addPkg">Add/Edit</button> <button type="button" class="whc-btn link" data-act="clearPkg">Clear</button></p>';
                        foot = slip + '<button type="button" class="whc-btn primary" data-act="markPacked" data-k="' + r.ifId + '" data-busy="' + (ok ? 'on' : 'off') + '">Mark packed</button>';
                    } else if (st === 'packed') {
                        body = (!d.tracking.some((n) => String(n).trim()) ? '<div class="whc-banner warn">Add a tracking number on the fulfillment before shipping.</div>' : '') + (d.labelPrinted ? '<div class="whc-banner ok">Label ready. Confirm shipment when dispatched.</div>'
                            : '<div class="whc-banner warn">Print a label to continue.</div>') + info + lines +
                            '<h3>Packages</h3>' + boxList(d.packages, false);
                        foot = slip + '<button type="button" class="whc-btn" data-act="shippingCost" data-k="' + r.ifId + '" data-busy="on">Calculate shipping cost</button>' + '<button type="button" class="whc-btn' + (d.labelPrinted ? '' : ' primary') + '" data-act="labelOne" data-k="' + r.ifId + '" data-busy="on">' + (d.labelPrinted ? 'Reprint label' : 'Print label') + '</button>' +
                            '<button type="button" class="whc-btn' + (d.labelPrinted ? ' primary' : '') + '" data-act="shipOne" data-k="' + r.ifId + '" data-busy="' + (d.labelPrinted && d.tracking.some((n) => String(n).trim()) ? 'on' : 'off') + '">Mark shipped</button>';
                    } else {
                        body = '<div class="whc-banner ok">Shipped.</div>' + info + lines;
                        foot = slip;
                    }
                }
            }
            $('whc-dbody').innerHTML = body;
            $('whc-dfoot').innerHTML = foot;
            renderBusy();
        }

        /* ---------- printing ---------- */
        function printTickets(ids) {
            const orders = ids.map((k) => findRow(k).row);
            const re = orders.filter((o) => o.printed);
            if (re.length && !window.confirm(re.map((o) => o.tranid + ' was printed ' + o.printedOn + ' by ' + o.printedBy + '.').join('\n') +
                '\n\nReprinting can send a second picker to the same bins. The ticket will be stamped as a reprint. Continue?')) return;
            const w = window.open('', '_blank');
            S.busy = true; renderBusy();
            api('POST', 'markPrinted', { soIds: ids }).then(() => {
                const link = CFG.url + '&action=ticketpdf&ids=' + ids.join(',');
                if (w) w.location.href = link; else window.open(link, '_blank');
                S.sel.clear();
                toast('Printed ' + plural(ids.length, 'picking ticket'));
                const keep = S.drawer;
                return load(true).then(() => keep ? openDrawer(keep) : null);
            }).catch((e) => { if (w) w.close(); toast(e.message, true); })
              .finally(() => { S.busy = false; renderBusy(); });
        }

        async function calculateShippingCost(ifId) {
            if (S.busy) return;
            S.busy = true; renderBusy();
            toast('Updating shipping settings and calculating cost…');
            try {
                const result = await api('POST', 'shippingCost', { ifId });
                const keep = S.drawer;
                await load(true);
                if (keep) await openDrawer(keep);
                toast('Shipping cost saved: ' + result.shippingCost.toFixed(2));
            } catch (e) {
                showError(e.message);
            } finally { S.busy = false; renderBusy(); }
        }

        function validZpl(text) {
            return typeof text === 'string' && /^\s*(?:~[^\^]*)?\^XA[\s\S]*\^XZ\s*$/.test(text)
                && !/<html|<!doctype/i.test(text);
        }

        async function fetchNativeLabel(label) {
            // NetSuite's thermal print job is session-scoped. Process one at a time.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            let next = label.url;
            try {
                for (let attempt = 0; attempt < 40; attempt++) {
                    const response = await fetch(next, {
                        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
                    });
                    if (!response.ok) throw new Error('Label request returned HTTP ' + response.status);
                    const text = await response.text();
                    if (validZpl(text)) return text;
                    // Follow only the native progress route observed in NLSPrintForm.
                    // Never execute scripts or inject the returned HTML into the console.
                    if (!/document\.location\.replace\(['"]\/app\/accounting\/print\/NLSPrintForm\.nl\?progress=T['"]\)/.test(text)) {
                        throw new Error('NetSuite did not return ZPL. Open the fulfillment, use Save & Print Label, then click Load label again. Check that the label format is ZPL.');
                    }
                    next = '/app/accounting/print/NLSPrintForm.nl?progress=T';
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
                throw new Error('Label rendering timed out. Check the native fulfillment before retrying.');
            } catch (e) {
                if (e.name === 'AbortError') throw new Error('Label request timed out. Check the native fulfillment before retrying.');
                throw e;
            } finally { clearTimeout(timer); }
        }

        function downloadZpl(text, filename) {
            const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
            const link = document.createElement('a');
            link.href = blobUrl; link.download = filename;
            document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        }

        async function printRenderedLabels(images, host) {
            if (!images || !images.length) throw new Error('Wait for the label preview before printing.');
            // A same-origin frame opens the browser print dialog without a tab or window.
            // Keep it inside the modal so it is not made inert by showModal().
            const frame = document.createElement('iframe');
            frame.title = 'Print shipping labels';
            frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:4in;height:6in;border:0';
            host.appendChild(frame);
            let cleanupTimer;
            const cleanup = () => { clearTimeout(cleanupTimer); frame.remove(); };
            try {
                const doc = frame.contentDocument;
                doc.open();
                doc.write('<!doctype html><html><head><title>Shipping label</title><style>' +
                    '@page{size:4in 6in;margin:0}html,body{margin:0;padding:0}' +
                    '.label{width:4in;height:6in;overflow:hidden;break-after:page;page-break-after:always}' +
                    '.label:last-child{break-after:auto;page-break-after:auto}' +
                    'img{display:block;width:4in;height:6in;object-fit:contain}' +
                    '</style></head><body></body></html>');
                doc.close();
                await Promise.all(images.map((image) => new Promise((resolve, reject) => {
                    const page = doc.createElement('div'); page.className = 'label';
                    const img = doc.createElement('img');
                    const timer = setTimeout(() => reject(new Error('Label image did not finish loading.')), 15000);
                    img.onload = () => { clearTimeout(timer); resolve(); };
                    img.onerror = () => { clearTimeout(timer); reject(new Error('Could not load label for printing.')); };
                    page.appendChild(img); doc.body.appendChild(page);
                    img.src = 'data:image/png;base64,' + image;
                })));
                frame.contentWindow.addEventListener('afterprint', () => setTimeout(cleanup, 0), { once: true });
                // Retain the frame for browsers where print() returns before the dialog closes.
                cleanupTimer = setTimeout(cleanup, 600000);
                frame.contentWindow.focus();
                frame.contentWindow.print();
            } catch (e) { cleanup(); throw e; }
        }

        async function printLabels(ifIds) {
            if (S.busy) return;
            S.busy = true; renderBusy();
            const dialog = document.createElement('dialog');
            dialog.setAttribute('aria-label', 'Shipping labels');
            dialog.style.cssText = 'width:min(560px,90vw);max-height:85vh;border:1px solid #d5dce5;border-radius:8px;padding:24px;overflow:auto;color:#243247';
            dialog.innerHTML = '<div style="display:flex;align-items:center;gap:20px"><h2 style="margin:0;flex:1">Label preview</h2><button type="button" class="whc-btn" data-label-close>Close</button></div>' +
                '<p data-label-status role="status">Loading labels…</p><div data-label-results></div>';
            root.appendChild(dialog);
            const status = dialog.querySelector('[data-label-status]');
            const results = dialog.querySelector('[data-label-results]');
            const close = dialog.querySelector('[data-label-close]');
            close.disabled = true;
            dialog.addEventListener('cancel', (event) => { if (S.busy) event.preventDefault(); });
            close.onclick = () => dialog.close();
            dialog.addEventListener('close', () => { dialog.remove(); const keep = S.drawer; load(true).then(() => { if (keep) openDrawer(keep); }); });
            dialog.showModal();
            const ready = [];
            const filename = (label) => String(label.ifNum).replace(/[^a-zA-Z0-9_-]/g, '_') + '.zpl';

            async function retrieve(label, section, autoDownload) {
                const message = section.querySelector('[data-label-message]');
                const retry = section.querySelector('[data-label-retry]');
                retry.disabled = true;
                const oldPrint = section.querySelector('[data-label-print]');
                if (oldPrint) oldPrint.disabled = true;
                message.textContent = 'Retrieving ZPL…';
                try {
                    const zpl = await fetchNativeLabel(label);
                    let entry = ready.find((r) => r.ifId === label.ifId);
                    if (!entry) { entry = { ifId: label.ifId }; ready.push(entry); }
                    entry.zpl = zpl; entry.filename = filename(label); entry.images = [];
                    let preview = section.querySelector('[data-label-preview]');
                    if (!preview) {
                        preview = document.createElement('div'); preview.dataset.labelPreview = '1';
                        section.appendChild(preview);
                        const controls = document.createElement('div');
                        controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0';
                        const download = document.createElement('button'); download.type = 'button'; download.className = 'whc-btn primary'; download.textContent = 'Download ZPL';
                        download.onclick = () => downloadZpl(entry.zpl, entry.filename);
                        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'whc-btn'; copy.textContent = 'Copy ZPL';
                        copy.onclick = async () => {
                            try { await navigator.clipboard.writeText(entry.zpl); message.textContent = 'Copied.'; }
                            catch (e) {
                                const temp = document.createElement('textarea'); temp.value = entry.zpl;
                                temp.style.cssText = 'position:fixed;opacity:0'; section.appendChild(temp); temp.select();
                                const copied = document.execCommand('copy'); temp.remove();
                                message.textContent = copied ? 'Copied.' : 'Copy unavailable. Use Download ZPL.';
                            }
                        };
                        const print = document.createElement('button');
                        print.type = 'button'; print.className = 'whc-btn'; print.textContent = 'Print';
                        print.dataset.labelPrint = '1'; print.disabled = true;
                        print.onclick = async () => {
                            print.disabled = true;
                            try { await printRenderedLabels(entry.images, section); }
                            catch (e) { message.textContent = 'Could not print label: ' + e.message; }
                            finally { print.disabled = !entry.images.length; }
                        };
                        controls.append(download, copy, print); section.appendChild(controls);
                    }
                    preview.textContent = 'Preparing preview…';
                    let previewError = '';
                    try {
                        const images = await renderLocalLabel(zpl);
                        if (!images.length) throw new Error('No preview returned.');
                        entry.images = images;
                        section.querySelector('[data-label-print]').disabled = false;
                        preview.replaceChildren();
                        images.forEach((image, index) => {
                            const img = document.createElement('img');
                            img.src = 'data:image/png;base64,' + image;
                            img.alt = label.ifNum + ' — label ' + (index + 1);
                            img.style.cssText = 'display:block;width:100%;height:auto;border:1px solid #d5dce5;margin:8px 0';
                            preview.appendChild(img);
                        });
                    } catch (e) { previewError = e.message; preview.textContent = previewError; }
                    section.querySelector('[data-label-tools]').style.display = previewError ? 'flex' : 'none';
                    if (autoDownload) downloadZpl(zpl, entry.filename);
                    try {
                        await api('POST', 'labelDownloaded', { ifId: label.ifId, zpl });
                        await load(true);
                        message.textContent = previewError ? '' : '4 × 6 in · Preview';
                    } catch (e) {
                        message.textContent = 'Could not save label status: ' + e.message;
                    }
                } catch (e) { message.textContent = e.message; section.querySelector('[data-label-tools]').style.display = 'flex'; }
                finally {
                    retry.disabled = false;
                    status.textContent = ready.length + ' / ' + ifIds.length + ' ready';
                }
            }
            // A cross-tab lock prevents two console tabs from mixing native print jobs.
            const withPrintLock = (fn) => navigator.locks
                ? navigator.locks.request('whc-native-thermal-print', { ifAvailable: true }, (lock) => {
                    if (!lock) throw new Error('Another console tab is loading labels. Wait for it to finish.');
                    return fn();
                }) : fn();
            try {
                const response = await api('POST', 'label', { ifIds });
                (response.skipped || []).forEach((s) => {
                    const p = document.createElement('p'); p.textContent = 'IF ' + s.ifId + ': ' + s.reason; results.appendChild(p);
                });
                await withPrintLock(async () => {
                    for (const label of response.labels) {
                        const section = document.createElement('section');
                        section.style.cssText = 'border-top:1px solid #d5dce5;padding:16px 0';
                        section.innerHTML = '<h3 style="margin-top:0">' + esc(label.ifNum) + '</h3>' +
                            '<p data-label-message role="status"></p><div data-label-tools style="display:flex;gap:12px;align-items:center">' +
                            '<a target="_blank" rel="noopener" href="' + esc(label.editUrl) + '">Open fulfillment</a>' +
                            '<button type="button" class="whc-btn" data-label-retry>Retry</button></div>';
                        results.appendChild(section);
                        section.querySelector('[data-label-retry]').onclick = async () => {
                            if (S.busy) return;
                            S.busy = true; renderBusy(); close.disabled = true;
                            try { await withPrintLock(() => retrieve(label, section, true)); }
                            catch (e) { section.querySelector('[data-label-message]').textContent = e.message; }
                            finally { S.busy = false; renderBusy(); close.disabled = false; }
                        };
                        await retrieve(label, section, false);
                    }
                });
                if (ready.length) {
                    // One file for a selection avoids multiple-download browser blocking.
                    const combined = ready.map((r) => r.zpl).join('\n');
                    const name = ready.length === 1 ? ready[0].filename : 'fulfillment-labels.zpl';
                    downloadZpl(combined, name);
                    if (ready.length > 1) {
                        const all = document.createElement('button'); all.type = 'button'; all.className = 'whc-btn primary'; all.textContent = 'Download all ZPL';
                        all.onclick = () => downloadZpl(ready.map((r) => r.zpl).join('\n'), name);
                        results.appendChild(all);
                    }
                }
                status.textContent = ready.length + ' / ' + ifIds.length + ' ready';
            } catch (e) { status.textContent = e.message; }
            finally { S.busy = false; renderBusy(); close.disabled = false; }
        }

        /* ---------- events ---------- */
        const ACT = {
            noop() {},
            refresh() { load(); },
            tab(el) { S.tab = el.dataset.k; S.workflow = 'all'; S.sel.clear(); render(); },
            open(el, e) { if (e.target.closest('a')) return; openDrawer(el.dataset.k); },
            close() { closeDrawer(); },
            releaseSel() {
                const ids = selected().filter((k) => !findRow(k).row.blocked);
                if (!window.confirm('Approve (if Pending Approval) and release all open qty on ' + plural(ids.length, 'order') + '? No POs are created.')) return;
                act('release', { soIds: ids }, (r) => 'Released ' + plural(r.released.length, 'order') + (r.skipped.length ? ', skipped ' + r.skipped.length : ''));
                S.sel.clear();
            },
            relAll() {
                const f = findRow(S.drawer); if (!f) return;
                f.row.lines.forEach((l) => {
                    const s = S.rel[l.lineId]; if (!s || s.d) return;
                    const av = lineStock(l, s.loc).available;
                    const q = av === null ? l.unreleased : Math.max(0, Math.min(l.unreleased, av));
                    s.r = q > 0; if (q > 0) s.rq = q;
                });
                if (f.row.pending) S.relApprove = true;
                renderDrawer();
            },
            applyRelease(el) {
                const f = findRow(el.dataset.k); if (!f) return;
                const v = relCheck(f.row);
                if (!v.ok) { refreshRelease(); return; }
                act('releaseLines', { soId: el.dataset.k, approve: !!(f.row.pending && S.relApprove), lines: v.lines }, (r) => {
                    const parts = [];
                    if (r.approved) parts.push('Approved');
                    if (r.released) parts.push('Released ' + r.released + ' units');
                    if (r.pos && r.pos.length) parts.push('PO ' + r.pos.join(', '));
                    return (r.tranid ? r.tranid + ': ' : '') + (parts.join(', ') || 'Saved');
                });
            },
            unrelease(el) { act('unrelease', { soId: el.dataset.k }, 'Returned to release'); },
            ticketsSel() { printTickets(selected()); },
            ticketOne(el) { printTickets([el.dataset.k]); },
            checkAll() { Object.values(S.pick).forEach((p) => { p.check = true; }); renderDrawer(); },
            markPicked(el) {
                root.querySelectorAll('[data-chg="pickQty"]').forEach(el => { if (S.pick[el.dataset.line]) S.pick[el.dataset.line].qty = el.value; });
                const lines = Object.keys(S.pick).filter((id) => S.pick[id].check).map((id) => ({ lineId: id, qty: Number(S.pick[id].qty) }));
                act('pick', { soId: el.dataset.k, lines }, (r) => r.ifNum + ' created in Picked status' + (r.releasedRemaining ? '. Remaining released qty stays in Ready to pick' : ''));
            },
            addPkg() {
                if (!validBox(S.box)) { showError('Enter a positive weight and all applicable dimensions for this box.'); return; }
                if (S.editBox < 0) S.pkgs.push(S.box); else S.pkgs[S.editBox] = S.box;
                resetBox(); $('whc-derror').replaceChildren(); renderDrawer();
            },
            clearPkg() { resetBox(); renderDrawer(); },
            editPkg(el) { if (S.boxDirty) { showError('Use Add/Edit or Clear before switching boxes.'); return; } S.editBox = Number(el.dataset.i); S.box = JSON.parse(JSON.stringify(S.pkgs[S.editBox])); renderDrawer(); },
            rmPkg(el) { if (S.boxDirty) { showError('Use Add/Edit or Clear before removing a box.'); return; } S.pkgs.splice(Number(el.dataset.i), 1); resetBox(); renderDrawer(); },
            markPacked(el) { if (packReady()) act('pack', { ifId: el.dataset.k, packages: S.pkgs }, 'Marked packed'); },
            packSlip(el) {
                const r = findRow(el.dataset.k).row;
                window.open(CFG.url + '&action=packslip&so=' + r.soId + '&if=' + r.ifId, '_blank');
            },
            shippingCost(el) { calculateShippingCost(el.dataset.k); },
            labelsSel() { printLabels(selected()); },
            labelOne(el) { printLabels([el.dataset.k]); },
            shipSel() {
                const ids = selected().filter((k) => findRow(k).row.labelPrinted);
                act('ship', { ifIds: ids }, (r) => 'Marked shipped: ' + r.shipped.length + (r.skipped.length ? ', skipped ' + r.skipped.length : ''));
                S.sel.clear();
            },
            shipOne(el) { act('ship', { ifIds: [el.dataset.k] }, (r) => r.shipped.length ? 'Marked shipped' : 'Not shipped: ' + (r.skipped[0] || {}).reason); }
        };

        root.addEventListener('click', (e) => {
            if (e.target.matches('input[type="checkbox"]')) return;
            if (e.target.id === 'whc-overlay') { if (!S.busy) closeDrawer(); return; }
            const el = e.target.closest('[data-act]');
            if (!el || el.disabled || S.busy) return;
            const fn = ACT[el.dataset.act];
            if (fn) { e.preventDefault(); fn(el, e); }
        });

        root.addEventListener('change', (e) => {
            const el = e.target, k = el.dataset.chg;
            if (!k) return;
            if (k === 'sel') { if (el.checked) S.sel.add(el.dataset.k); else S.sel.delete(el.dataset.k); renderList(); renderBulk(); }
            else if (k === 'selAll') { rows().forEach((r) => { if (el.checked) S.sel.add(keyOf(r)); else S.sel.delete(keyOf(r)); }); renderList(); renderBulk(); }
            else if (k === 'workflow') { S.workflow = el.value; renderList(); renderBulk(); }
            else if (k === 'ch') { S.ch = el.value; renderList(); renderBulk(); }
            else if (k === 'cm') { S.cm = el.value; renderList(); renderBulk(); }
            else if (k === 'st') { S.st = el.value; renderList(); renderBulk(); }
            else if (k === 'od') { S.od = el.value; renderList(); renderBulk(); }
            else if (k === 'relApprove') { S.relApprove = el.value === 'B'; renderDrawer(); }
            else if (k === 'relLoc') { const s = S.rel[el.dataset.line]; if (!s) return; s.loc = el.value; renderDrawer(); }
            else if (k === 'relChk' || k === 'dsChk') {
                const s = S.rel[el.dataset.line]; if (!s) return;
                if (k === 'relChk') s.r = el.checked; else s.d = el.checked;
                renderDrawer();
            }
            else if (k === 'relQty') {
                const s = S.rel[el.dataset.line]; if (!s) return;
                s.rq = el.value;
                refreshRelease();
            }
            else if (k === 'pickChk') { S.pick[el.dataset.line].check = el.checked; renderDrawer(); }
            else if (k === 'pickQty') { S.pick[el.dataset.line].qty = el.value; }
            else if (k === 'box') {
                S.boxDirty = true; const kf = el.dataset.f; if (axes.includes(kf)) { if (!S.box.dimensions) S.box.dimensions = {}; S.box.dimensions[kf] = el.value; } else S.box[kf] = el.value;
                const btn = root.querySelector('[data-act="markPacked"]');
                if (btn) { btn.dataset.busy = packReady() ? 'on' : 'off'; renderBusy(); }
            }
        });

        root.addEventListener('input', (e) => {
            const k = e.target.dataset.chg;
            if (k === 'q') { S.q = e.target.value; renderList(); renderBulk(); }
            else if (k === 'pickQty' && S.pick[e.target.dataset.line]) { S.pick[e.target.dataset.line].qty = e.target.value; }
            else if (k === 'relQty') { e.target.dispatchEvent(new Event('change', { bubbles: true })); }
            else if (k === 'box') { e.target.dispatchEvent(new Event('change', { bubbles: true })); }
        });

        // NetSuite forms submit on Enter inside inputs; keep the console self-contained
        root.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
        });

        $('whc-overlay').addEventListener('cancel', e => { e.preventDefault(); if (!S.busy) closeDrawer(); });
        load();
    }

    return { onRequest };
});