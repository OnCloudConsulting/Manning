/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * wh_fulfillment_lib.js
 * Data + actions for the Warehouse Fulfillment Console Suitelet (wh_fulfillment_console_sl.js).
 *
 * Flow
 *   Release      -> SO Pending Fulfillment / Partially Fulfilled / Pending Billing-Partially Fulfilled
 *                   with open qty not yet released (custcol_whc_release_qty). Release-access users only.
 *   Ready to pick -> lines with released qty (capped by committed); custbody_released_to_wh = T
 *   Picked       -> Item Fulfillment shipstatus A
 *   Packed       -> Item Fulfillment shipstatus B (packages populated)
 *   Shipped      -> Item Fulfillment shipstatus C (last N days)
 *
 * Release (commitment is NOT used: Fulfill Based on Commitment = Ignore Commitment)
 *   - Release tab shows Pending Approval orders and approved orders with unreleased open qty,
 *     with on hand / available per location.
 *   - Per line: pick the location, release qty to the warehouse, or Create PO (Drop Ship, item vendor).
 *   - Submit on a Pending Approval order sets the lines and approves it in one save, so NetSuite
 *     creates and links the dropship PO itself. A line with a linked PO is excluded from the warehouse.
 *   - Each line can be released to the warehouse (partly or fully), or sent to a PO.
 *     PO creation mirrors the native line link (purchord.nl?soid=&specord=T|dropship=T&custid=&nexus=
 *     &subsidiary=&entity=&poentity=). It works for lines NetSuite already marked Drop Ship / Special Order
 *     (Create PO can't be changed once the order is approved).
 *   - Pick tickets, Ready to pick and pick validation use the released qty.
 *   - After a pick, released qty is reduced by what was picked.
 *   - Orders released before line-level release (header flag only, no line qty) keep the old behaviour:
 *     all committed qty counts as released.
 *   - Who can release: Administrator role, or employees with custentity_whc_release_access checked.
 *
 * Line rules
 *   - Dropship line WITH a line-level PO (createdpo) -> ignored
 *     (tl.isdropship is not exposed to SuiteQL in this account, so a line is treated as
 *      dropship-with-PO when createdpo is set AND nothing is committed. Dropship lines never
 *      commit; special-order lines commit once the PO is received and then become pickable.)
 *   - Dropship line WITHOUT a PO yet -> shows as an uncommitted line until the PO is created
 *   - IF stage comes from transaction.status (ItemShip A/B/C); shipstatus is not exposed to SuiteQL
 *   - Pickable qty excludes quantities already picked (including packed/shipped).
 */
define(['N/query', 'N/record', 'N/search', 'N/runtime', 'N/render', 'N/url', 'N/log', 'N/https', 'N/xml', 'N/format'],
(query, record, search, runtime, render, url, log, https, xml, format) => {

    /* ------------------------------------------------------------------ */
    /*  Configuration                                                      */
    /* ------------------------------------------------------------------ */

    const FLD = {
        channel:       'custbody_sourcechannel',
        hold:          'custbody_so_on_hold',
        doNotPick:     'custbody3',
        released:      'custbody_released_to_wh',
        releasedBy:    'custbody_released_by',
        releasedOn:    'custbody_released_on',
        printed:       'custbody_pick_ticket_printed',
        printedBy:     'custbody_pick_printed_by',
        printedOn:     'custbody_pick_printed_on',
        printCount:    'custbody_pick_print_count',
        labelPrinted:  'custbody_label_printed',          // on Item Fulfillment
        releaseQty:    'custcol_whc_release_qty',         // SO line: qty released to the warehouse, not yet picked
        releaseAccess: 'custentity_whc_release_access'    // Employee: can release orders / create dropship POs
    };

    const ITEM_TYPES = ['InvtPart', 'Assembly'];
    const SHIP = { PICKED: 'A', PACKED: 'B', SHIPPED: 'C' };
    const MIN_USAGE = 150;
    const ADMIN_ROLE = 3;

    // Package sublists per carrier on Item Fulfillment
    const PKG = {
        packageups:   { weight: 'packageweightups',   descr: 'packagedescrups', tracking: 'packagetrackingnumberups' },
        packagefedex: { weight: 'packageweightfedex', descr: null,              tracking: 'packagetrackingnumberfedex' },
        package:      { weight: 'packageweight',      descr: 'packagedescr',    tracking: 'packagetrackingnumber' }
    };

    const getParams = () => {
        const s = runtime.getCurrentScript();
        return {
            location:    s.getParameter({ name: 'custscript_whc_location' }) || null,
            shippedDays: Number(s.getParameter({ name: 'custscript_whc_shipped_days' })) || 2,
            labelUrl:    s.getParameter({ name: 'custscript_whc_label_url' }) || ''
        };
    };

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */

    const qMarks  = (arr) => arr.map(() => '?').join(',');
    const toIds   = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
        .map((x) => parseInt(x, 10)).filter((n) => n > 0);
    const num     = (v) => Number(v) || 0;
    const isTrue  = (v) => v === true || v === 'T';
    const hasValue = (v) => v !== null && v !== undefined && v !== '';
    const userId  = () => runtime.getCurrentUser().id;
    const usage   = () => runtime.getCurrentScript().getRemainingUsage();
    const chunk   = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    const xmlEsc  = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    function runSql(sql, params) {
        const out = [];
        try {
            const paged = query.runSuiteQLPaged({ query: sql, params: params || [], pageSize: 1000 });
            paged.pageRanges.forEach((range) => {
                paged.fetch({ index: range.index }).data.asMappedResults().forEach((r) => out.push(r));
            });
            return out;
        } catch (e) {
            // Paged queries hide the cause behind UNEXPECTED_ERROR; the plain call returns the real message
            log.error({ title: 'SuiteQL paged failed', details: `${e.message}\n${sql}` });
            try {
                return query.runSuiteQL({ query: sql, params: params || [] }).asMappedResults();
            } catch (e2) {
                throw new Error(`SuiteQL failed: ${e2.message}. Open the console URL with &action=diag to find the column.`);
            }
        }
    }

    /**
     * Tests each column the console relies on, one at a time.
     * Open the Suitelet URL with &action=diag
     */
    function diagnose() {
        const so = `FROM transaction t JOIN transactionline tl ON tl.transaction = t.id JOIN item i ON i.id = tl.item
                    WHERE t.type = 'SalesOrd' AND tl.mainline = 'F' AND ROWNUM <= 1`;
        const ff = `FROM transaction f JOIN transactionline fl ON fl.transaction = f.id
                    WHERE f.type = 'ItemShip' AND fl.mainline = 'F' AND ROWNUM <= 1`;
        const probes = [
            ['SO', `t.${FLD.hold}`], ['SO', `t.${FLD.doNotPick}`], ['SO', 't.status'], ['SO', 'BUILTIN.DF(t.status)'], ['SO', 't.trandate'],
            ['SO', `BUILTIN.DF(t.${FLD.channel})`], ['SO', 'BUILTIN.DF(t.entity)'],
            ['SO', 'BUILTIN.DF(t.shipmethod)'], ['SO', 't.shippingaddress'],
            ['SO', `t.${FLD.released}`], ['SO', `BUILTIN.DF(t.${FLD.releasedBy})`], ['SO', `t.${FLD.releasedOn}`],
            ['SO', `t.${FLD.printed}`], ['SO', `BUILTIN.DF(t.${FLD.printedBy})`], ['SO', `t.${FLD.printedOn}`], ['SO', `t.${FLD.printCount}`],
            ['SO', 'tl.id'], ['SO', 'tl.quantity'], ['SO', 'tl.quantityshiprecv'], ['SO', 'tl.quantitycommitted'],
            ['SO', 'tl.quantitypicked'], ['SO', 'tl.createdpo'], ['SO', 'BUILTIN.DF(tl.createdpo)'], ['SO', `tl.${FLD.releaseQty}`],
            ['SO', 'tl.isclosed'], ['SO', 'tl.taxline'], ['SO', 'tl.location'], ['SO', 'BUILTIN.DF(tl.location)'], ['SO', 't.location'], ['SO', 'tl.linesequencenumber'],
            ['SO', 'i.itemid'], ['SO', 'i.displayname'], ['SO', 'i.itemtype'],
            ['IF', 'f.status'], ['IF', `f.${FLD.labelPrinted}`], ['IF', 'BUILTIN.DF(f.shipmethod)'],
            ['IF', 'fl.createdfrom'], ['IF', 'fl.iscogs'], ['IF', 'fl.location'], ['IF', 'fl.item']
        ];
        const extra = [
            ['address join', `SELECT tsa.addrtext AS x FROM transaction t LEFT JOIN transactionShippingAddress tsa ON tsa.nkey = t.shippingaddress WHERE t.type = 'SalesOrd' AND ROWNUM <= 1`],
            ['itemvendor', `SELECT iv.item AS x FROM itemvendor iv WHERE iv.preferredvendor = 'T' AND ROWNUM <= 1`],
            ['location list', `SELECT id AS x FROM location WHERE NVL(isinactive, 'F') = 'F' AND ROWNUM <= 1`],
            ['inventoryitemlocations', `SELECT iil.item AS x, iil.location AS l, iil.quantityonhand AS h, iil.quantityavailable AS a FROM inventoryitemlocations iil WHERE ROWNUM <= 1`],
            ['drop ship PO join', `SELECT po.tranid AS x, po.duedate AS d, BUILTIN.DF(po.status) AS st, BUILTIN.DF(po.entity) AS v
                FROM transaction t JOIN transactionline tl ON tl.transaction = t.id JOIN transaction po ON po.id = tl.createdpo
                WHERE t.type = 'SalesOrd' AND ROWNUM <= 1`]
        ];
        const extraRes = extra.map(([expr, q]) => {
            try { query.runSuiteQL({ query: q }); return { src: 'SO', expr, ok: true }; }
            catch (e) { return { src: 'SO', expr, ok: false, error: e.message }; }
        });
        return extraRes.concat(probes.map(([src, expr]) => {
            try {
                query.runSuiteQL({ query: `SELECT ${expr} AS x ${src === 'SO' ? so : ff}` });
                return { src, expr, ok: true };
            } catch (e) {
                return { src, expr, ok: false, error: e.message };
            }
        }));
    }

    /* ------------------------------------------------------------------ */
    /*  Release permission                                                 */
    /* ------------------------------------------------------------------ */

    function canRelease() {
        const user = runtime.getCurrentUser();
        if (Number(user.role) === ADMIN_ROLE) return true;
        try {
            const emp = search.lookupFields({ type: search.Type.EMPLOYEE, id: user.id, columns: [FLD.releaseAccess] });
            return isTrue(emp[FLD.releaseAccess]);
        } catch (e) {
            log.audit({ title: 'Release access lookup failed', details: e.message });
            return false;
        }
    }

    function assertRelease() {
        if (!canRelease()) throw new Error('You do not have permission to release orders or create dropship POs.');
    }

    /* ------------------------------------------------------------------ */
    /*  Order pool (Release / Ready to pick)                               */
    /* ------------------------------------------------------------------ */

    function loadOrders(soIds) {
        const p = getParams();
        const args = [...ITEM_TYPES];
        let where = `
            t.type = 'SalesOrd'
            AND t.status IN ('A','B','D','E')
            AND tl.mainline = 'F'
            AND tl.taxline = 'F'
            AND NVL(tl.isclosed, 'F') = 'F'
            AND i.itemtype IN (${qMarks(ITEM_TYPES)})`;

        if (p.location) {
            // Pending Approval lines may not have a location yet
            where += ` AND (tl.location = ? OR tl.location IS NULL OR tl.createdpo IS NOT NULL)`;
            args.push(p.location);
        }
        if (soIds && soIds.length) {
            where += ` AND t.id IN (${qMarks(soIds)})`;
            args.push(...soIds);
        }

        const rows = runSql(`
            SELECT
                t.id                                   AS so_id,
                t.tranid                               AS tranid,
                t.trandate                             AS trandate,
                t.status                               AS status_code,
                BUILTIN.DF(t.status)                   AS status_text,
                BUILTIN.DF(t.${FLD.channel})           AS channel,
                BUILTIN.DF(t.entity)                   AS customer,
                BUILTIN.DF(t.shipmethod)               AS ship_via,
                tsa.addrtext                           AS ship_to,
                t.location                             AS hdr_loc,
                t.${FLD.hold}                          AS on_hold,
                t.${FLD.doNotPick}                     AS do_not_pick,
                t.${FLD.released}                      AS released,
                BUILTIN.DF(t.${FLD.releasedBy})        AS released_by,
                t.${FLD.releasedOn}                    AS released_on,
                t.${FLD.printed}                       AS printed,
                BUILTIN.DF(t.${FLD.printedBy})         AS printed_by,
                t.${FLD.printedOn}                     AS printed_on,
                t.${FLD.printCount}                    AS print_count,
                tl.id                                  AS line_id,
                tl.item                                AS item_id,
                tl.location                            AS loc_id,
                BUILTIN.DF(tl.location)                AS loc_name,
                i.itemid                               AS sku,
                NVL(i.displayname, i.itemid)           AS item_name,
                ABS(tl.quantity)                       AS qty,
                NVL(tl.quantityshiprecv, 0)            AS fulfilled,
                NVL(tl.quantitypicked, 0)              AS qty_picked,
                tl.${FLD.releaseQty}                   AS release_qty,
                tl.createdpo                           AS po_id,
                BUILTIN.DF(tl.createdpo)               AS po_num
            FROM transaction t
            JOIN transactionline tl ON tl.transaction = t.id
            JOIN item i ON i.id = tl.item
            LEFT JOIN transactionShippingAddress tsa ON tsa.nkey = t.shippingaddress
            WHERE ${where}
            ORDER BY t.trandate, t.id, tl.linesequencenumber`, args);

        const map = new Map();
        rows.forEach((r) => {
            let o = map.get(r.so_id);
            if (!o) {
                o = {
                    id: r.so_id, tranid: r.tranid, date: r.trandate, status: r.status_text,
                    statusCode: r.status_code, pending: r.status_code === 'A',
                    channel: r.channel || '', customer: r.customer || '', shipVia: r.ship_via || '',
                    shipTo: r.ship_to || '', hdrLoc: r.hdr_loc ? String(r.hdr_loc) : '',
                    blocked: isTrue(r.on_hold) ? 'On hold' : (isTrue(r.do_not_pick) ? 'Do not pick' : ''),
                    released: isTrue(r.released), releasedBy: r.released_by || '', releasedOn: r.released_on || '',
                    printed: isTrue(r.printed), printedBy: r.printed_by || '', printedOn: r.printed_on || '',
                    printCount: num(r.print_count), lines: []
                };
                map.set(r.so_id, o);
            }
            const qty = num(r.qty);
            const ful = Math.abs(num(r.fulfilled));
            // Native picked quantity is cumulative through packed and shipped.
            const picked = Math.max(ful, Math.abs(num(r.qty_picked)));
            const rem = Math.max(0, qty - picked);
            // Commitment is not used (Fulfill Based on Commitment = Ignore Commitment).
            // A line with a linked PO is vendor-fulfilled (dropship) and excluded from the warehouse.
            const ds = !!r.po_id;
            o.lines.push({
                lineId: r.line_id, itemId: r.item_id, sku: r.sku, name: r.item_name,
                locId: r.loc_id ? String(r.loc_id) : '', locName: r.loc_name || '',
                qty, fulfilled: ful, picked, remaining: rem,
                rqSet: hasValue(r.release_qty),
                released: Math.min(Math.max(0, num(r.release_qty)), rem),
                committed: 0,
                dropship: ds, hasPo: ds, po: r.po_id ? (r.po_num || String(r.po_id)) : null,
                ignored: ds,
                bin: '', binId: null
            });
        });

        const orders = [...map.values()];
        orders.forEach(applyRelease);
        return orders.map(decorate);
    }

    // released = qty in the warehouse queue, unreleased = open qty still to decide.
    // committed (kept as the field name the pick/ticket code uses) = pickable qty = released qty.
    function applyRelease(o) {
        // Nothing on a Pending Approval order counts as released, even if release data was
        // copied onto it (Make Copy) or left from an earlier approval.
        o.legacy = !o.pending && o.released && !o.lines.some((l) => l.rqSet);
        o.lines.forEach((l) => {
            if (l.dropship) { l.released = 0; l.unreleased = 0; l.releasable = 0; l.committed = 0; return; }
            if (o.pending) l.released = 0;
            if (o.legacy) l.released = l.remaining;              // released before line-level release: whole open qty
            l.unreleased = Math.max(0, l.remaining - l.released);
            l.releasable = l.unreleased;
            l.committed  = l.released;
        });
    }

    function decorate(o) {
        const open = o.lines.filter((l) => !l.dropship && l.remaining > 0);
        const need = open.reduce((a, l) => a + l.remaining, 0);
        const have = open.reduce((a, l) => a + l.committed, 0);
        o.openLines   = open.length;
        o.openUnits   = need;
        o.pickLines   = open.filter((l) => l.committed > 0).length;
        o.pickUnits   = have;
        o.commit      = have === 0 ? 'none' : (have < need ? 'partial' : 'full');
        o.ignoredPos  = o.lines.filter((l) => l.ignored && l.remaining > 0).map((l) => l.po);
        o.awaitingPo  = 0;

        // Release view (unreleased qty only); stock status is set in attachStock
        const relOpen = o.lines.filter((l) => !l.dropship && l.unreleased > 0);
        o.relLines      = relOpen.length;
        o.relUnits      = relOpen.reduce((a, l) => a + l.unreleased, 0);
        o.relReady      = 0;
        o.releasedUnits = o.lines.reduce((a, l) => a + (l.dropship ? 0 : l.released), 0);
        o.relCommit     = 'none';
        return o;
    }

    function getPreferredBins(itemIds) {
        const out = {};
        if (!itemIds.length) return out;
        const p = getParams();
        // Bin fields belong to the native item sublist; do not use the
        // unsupported binNumber search join or item binnumber search column.
        search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', itemIds]],
            columns: ['internalid']
        }).run().each((r) => {
            try {
                const item = record.load({ type: r.recordType, id: r.id });
                if (!isTrue(item.getValue({ fieldId: 'usebins' }))) return true;
                if (item.getSublists().indexOf('binnumber') === -1) return true;
                for (let line = 0; line < item.getLineCount({ sublistId: 'binnumber' }); line++) {
                    const value = (fieldId) => item.getSublistValue({ sublistId: 'binnumber', fieldId, line });
                    if (!isTrue(value('preferredbin'))) continue;
                    const binId = value('binnumber');
                    if (!binId) continue;
                    const bin = search.lookupFields({ type: search.Type.BIN, id: binId,
                        columns: ['location', 'isinactive'] });
                    if (isTrue(bin.isinactive)) continue;
                    const locationId = (bin.location && bin.location[0] && bin.location[0].value) || '';
                    if (p.location && String(locationId) !== String(p.location)) continue;
                    out[r.id] = { bin: item.getSublistText({ sublistId: 'binnumber', fieldId: 'binnumber', line }) || '', binId };
                    break;
                }
            } catch (e) {
                log.audit({ title: 'Preferred bin unavailable for item ' + r.id, details: e.message });
            }
            return true;
        });
        return out;
    }

    function attachBins(orders) {
        const ids = [...new Set(orders.flatMap((o) => o.lines.filter((l) => !l.dropship).map((l) => l.itemId)))];
        const bins = getPreferredBins(ids);
        orders.forEach((o) => o.lines.forEach((l) => {
            const b = bins[l.itemId];
            if (b) { l.bin = b.bin; l.binId = b.binId; }
        }));
    }

    // On hand / available per item per location: { itemId: { locId: { onHand, available } } }
    // Primary source: SuiteQL inventoryitemlocations (same numbers as the item's Locations subtab).
    // Fallback: item search location columns.
    function getStock(itemIds) {
        const out = {};
        if (!itemIds.length) return out;
        const put = (item, loc, onHand, available) => {
            if (!loc) return;
            if (!out[item]) out[item] = {};
            out[item][String(loc)] = { onHand: num(onHand), available: num(available) };
        };
        try {
            chunk(itemIds, 900).forEach((ids) => {
                query.runSuiteQL({
                    query: `SELECT iil.item AS item_id, iil.location AS loc_id,
                                   NVL(iil.quantityonhand, 0) AS on_hand, NVL(iil.quantityavailable, 0) AS available
                            FROM inventoryitemlocations iil
                            WHERE iil.item IN (${qMarks(ids)})`,
                    params: ids
                }).asMappedResults().forEach((r) => put(String(r.item_id), r.loc_id, r.on_hand, r.available));
            });
            return out;
        } catch (e) {
            log.audit({ title: 'inventoryitemlocations unavailable, using item search', details: e.message });
        }
        try {
            chunk(itemIds, 500).forEach((ids) => {
                search.create({
                    type: search.Type.ITEM,
                    filters: [['internalid', 'anyof', ids]],
                    columns: [
                        search.createColumn({ name: 'inventorylocation' }),
                        search.createColumn({ name: 'locationquantityonhand' }),
                        search.createColumn({ name: 'locationquantityavailable' })
                    ]
                }).run().each((r) => {
                    put(String(r.id), r.getValue({ name: 'inventorylocation' }),
                        r.getValue({ name: 'locationquantityonhand' }), r.getValue({ name: 'locationquantityavailable' }));
                    return true;
                });
            });
        } catch (e) {
            log.error({ title: 'Stock lookup failed', details: e.message });
        }
        return out;
    }

    /**
     * Stock for one order, from the same places the SO shows it:
     *   lines: SO line On Hand / Available (for the line's location, or total when the line has no location)
     *   items: item record Locations subtab, every location { onHand, available }
     */
    function getOrderStock(soId) {
        const id = toIds(soId)[0];
        const so = record.load({ type: record.Type.SALES_ORDER, id });
        const lines = {}, itemIds = new Set();
        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
            const g = (f) => { try { return so.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return null; } };
            if (ITEM_TYPES.indexOf(g('itemtype')) < 0) continue;
            const itemId = String(g('item'));
            itemIds.add(itemId);
            lines[String(g('line'))] = {
                itemId, loc: g('location') ? String(g('location')) : '',
                onHand: hasValue(g('quantityonhand')) ? num(g('quantityonhand')) : null,
                available: hasValue(g('quantityavailable')) ? num(g('quantityavailable')) : null
            };
        }
        const items = {};
        if (itemIds.size) {
            search.create({ type: search.Type.ITEM, filters: [['internalid', 'anyof', [...itemIds]]], columns: ['internalid'] })
                .run().each((r) => {
                    if (usage() < 100) return false;
                    try {
                        const rec = record.load({ type: r.recordType, id: r.id });
                        if (rec.getSublists().indexOf('locations') < 0) return true;
                        const out = {};
                        for (let j = 0; j < rec.getLineCount({ sublistId: 'locations' }); j++) {
                            const v = (f) => { try { return rec.getSublistValue({ sublistId: 'locations', fieldId: f, line: j }); } catch (e) { return null; } };
                            const loc = v('locationid') || v('location');
                            if (!loc) continue;
                            out[String(loc)] = { onHand: num(v('quantityonhand')), available: num(v('quantityavailable')) };
                        }
                        items[String(r.id)] = out;
                    } catch (e) {
                        log.audit({ title: 'Item locations unavailable for ' + r.id, details: e.message });
                    }
                    return true;
                });
        }
        return { lines, items };
    }

    // Debug: compare the console's stock with what the SO lines show (&action=stockcheck&so=<internal id>)
    function stockCheck(soId) {
        const id = toIds(soId)[0];
        const so = record.load({ type: record.Type.SALES_ORDER, id });
        const lines = [];
        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
            const g = (f) => { try { return so.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return null; } };
            lines.push({
                line: g('line'), itemId: String(g('item')), sku: so.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }),
                lineLocation: g('location'), soOnHand: g('quantityonhand'), soAvailable: g('quantityavailable')
            });
        }
        const stock = getStock([...new Set(lines.map((l) => l.itemId))]);
        return {
            headerLocation: so.getValue({ fieldId: 'location' }),
            lines: lines.map((l) => Object.assign(l, { consoleByLocation: stock[l.itemId] || {} }))
        };
    }

    function getVendors(itemIds) {
        const out = {};
        if (!itemIds.length) return out;
        try {
            chunk(itemIds, 900).forEach((ids) => {
                query.runSuiteQL({
                    query: `SELECT iv.item AS item_id, iv.vendor AS vendor_id, BUILTIN.DF(iv.vendor) AS vendor
                            FROM itemvendor iv WHERE iv.item IN (${qMarks(ids)})
                            ORDER BY CASE WHEN iv.preferredvendor = 'T' THEN 0 ELSE 1 END`,
                    params: ids
                }).asMappedResults().forEach((r) => {
                    if (!out[r.item_id]) out[r.item_id] = { id: String(r.vendor_id), name: r.vendor };
                });
            });
        } catch (e) {
            log.audit({ title: 'Vendor lookup unavailable', details: e.message });
        }
        return out;
    }

    function getLocations() {
        try {
            return runSql(`SELECT id, name FROM location WHERE NVL(isinactive, 'F') = 'F' ORDER BY name`, [])
                .map((r) => ({ id: String(r.id), name: r.name }));
        } catch (e) {
            log.audit({ title: 'Location list unavailable', details: e.message });
            return [];
        }
    }

    function attachStock(orders) {
        const p = getParams();
        const ids = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.itemId)))];
        const stock = getStock(ids);
        const vendors = getVendors(ids);
        orders.forEach((o) => {
            let have = 0;
            o.lines.forEach((l) => {
                l.stock = stock[l.itemId] || {};
                const v = vendors[l.itemId];
                l.vendor = v ? v.name : '';
                // Totals across all locations (shown when the line has no location yet)
                const all = Object.values(l.stock);
                l.stock[''] = all.length ? {
                    onHand: all.reduce((x, v) => x + v.onHand, 0),
                    available: all.reduce((x, v) => x + v.available, 0)
                } : undefined;
                if (!l.stock['']) delete l.stock[''];
                l.defaultLoc = l.locId || o.hdrLoc || (p.location ? String(p.location) : '');
                const s = l.stock[l.defaultLoc];
                l.onHand = s ? s.onHand : null;
                l.available = s ? s.available : null;
                if (!l.dropship && l.unreleased > 0) have += Math.min(l.unreleased, Math.max(0, num(l.available)));
            });
            o.relReady = have;
            o.relCommit = have === 0 ? 'none' : (have < o.relUnits ? 'partial' : 'full');
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Fulfillments (Picked / Packed / Shipped)                           */
    /* ------------------------------------------------------------------ */

    function loadFulfillments() {
        const p = getParams();
        const args = [...ITEM_TYPES, p.shippedDays];
        let locSql = '';
        if (p.location) { locSql = ' AND fl.location = ?'; args.push(p.location); }

        // Actual fulfillment item rows can be mainline=T. Exclude COGS, not mainline.
        const rows = runSql(`
            SELECT
                f.id                                   AS if_id,
                f.tranid                               AS if_num,
                f.status                               AS ship_status,
                f.trandate                             AS trandate,
                f.${FLD.labelPrinted}                  AS label_printed,
                BUILTIN.DF(f.shipmethod)               AS ship_via,
                so.id                                  AS so_id,
                so.tranid                              AS so_num,
                BUILTIN.DF(so.status)                  AS so_status,
                BUILTIN.DF(so.${FLD.channel})          AS channel,
                BUILTIN.DF(so.entity)                  AS customer,
                i.itemid                               AS sku,
                NVL(i.displayname, i.itemid)           AS item_name,
                ABS(fl.quantity)                       AS qty
            FROM transaction f
            JOIN transactionline fl ON fl.transaction = f.id
            JOIN transactionline fh ON fh.transaction = f.id AND fh.mainline = 'T'
            JOIN transaction so ON so.id = fh.createdfrom AND so.type = 'SalesOrd' 
            JOIN item i ON i.id = fl.item
            WHERE f.type = 'ItemShip'
              AND fl.taxline = 'F'
              AND NVL(fl.iscogs, 'F') = 'F'
              AND i.itemtype IN (${qMarks(ITEM_TYPES)})
              AND (f.status IN ('A','B') OR (f.status = 'C' AND f.trandate >= TRUNC(SYSDATE) - ?))
              ${locSql}
            ORDER BY f.id, fl.id`, args);

        const map = new Map();
        rows.forEach((r) => {
            let f = map.get(r.if_id);
            if (!f) {
                f = {
                    ifId: r.if_id, ifNum: r.if_num, shipStatus: r.ship_status, date: r.trandate,
                    labelPrinted: isTrue(r.label_printed), shipVia: r.ship_via || '',
                    soId: r.so_id, soNum: r.so_num, soStatus: r.so_status,
                    channel: r.channel || '', customer: r.customer || '', lines: [], units: 0
                };
                map.set(r.if_id, f);
            }
            f.lines.push({ sku: r.sku, name: r.item_name, qty: num(r.qty) });
            f.units += num(r.qty);
        });
        return [...map.values()];
    }

    function pkgSublist(rec) {
        const subs = rec.getSublists();
        return Object.keys(PKG).find((s) => subs.indexOf(s) > -1) || null;
    }

    function readPackages(rec) {
        const sub = pkgSublist(rec);
        if (!sub) return [];
        const f = PKG[sub];
        const out = [];
        for (let i = 0; i < rec.getLineCount({ sublistId: sub }); i++) {
            out.push({
                weight: rec.getSublistValue({ sublistId: sub, fieldId: f.weight, line: i }) || '',
                dimensions: sub === 'packagefedex' ? Object.fromEntries(['length','width','height'].map(k=>[k,rec.getSublistValue({sublistId:sub,fieldId:'package'+k+'fedex',line:i}) || ''])) : null,
                descr: f.descr ? (rec.getSublistValue({ sublistId: sub, fieldId: f.descr, line: i }) || '') : '',
                tracking: rec.getSublistValue({ sublistId: sub, fieldId: f.tracking, line: i }) || ''
            });
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /*  Drop Ship pending delivery (SO lines with a linked PO, not yet delivered) */
    /* ------------------------------------------------------------------ */

    function loadDropship() {
        const rows = runSql(`
            SELECT
                t.id                                   AS so_id,
                t.tranid                               AS tranid,
                t.trandate                             AS trandate,
                BUILTIN.DF(t.status)                   AS status_text,
                BUILTIN.DF(t.${FLD.channel})           AS channel,
                BUILTIN.DF(t.entity)                   AS customer,
                tl.id                                  AS line_id,
                i.itemid                               AS sku,
                NVL(i.displayname, i.itemid)           AS item_name,
                ABS(tl.quantity)                       AS qty,
                NVL(tl.quantityshiprecv, 0)            AS delivered,
                po.id                                  AS po_id,
                po.tranid                              AS po_num,
                po.trandate                            AS po_date,
                po.duedate                             AS po_due,
                BUILTIN.DF(po.status)                  AS po_status,
                BUILTIN.DF(po.entity)                  AS vendor,
                TRUNC(SYSDATE) - po.trandate           AS days_open,
                CASE WHEN po.duedate < TRUNC(SYSDATE) THEN 'T' ELSE 'F' END AS overdue
            FROM transaction t
            JOIN transactionline tl ON tl.transaction = t.id
            JOIN item i ON i.id = tl.item
            JOIN transaction po ON po.id = tl.createdpo
            WHERE t.type = 'SalesOrd'
              AND t.status IN ('B','D','E')
              AND tl.mainline = 'F'
              AND tl.taxline = 'F'
              AND NVL(tl.isclosed, 'F') = 'F'
              AND ABS(tl.quantity) - NVL(tl.quantityshiprecv, 0) > 0
            ORDER BY po.trandate, t.id, tl.linesequencenumber`, []);

        const map = new Map();
        rows.forEach((r) => {
            let o = map.get(r.so_id);
            if (!o) {
                o = {
                    id: r.so_id, tranid: r.tranid, date: r.trandate, status: r.status_text,
                    channel: r.channel || '', customer: r.customer || '',
                    lines: [], pos: [], vendors: [], units: 0, overdue: false, daysOpen: 0, oldestPo: '', receiveBy: ''
                };
                map.set(r.so_id, o);
            }
            const qty = num(r.qty), delivered = Math.abs(num(r.delivered));
            const line = {
                lineId: r.line_id, sku: r.sku, name: r.item_name, qty, delivered, pending: Math.max(0, qty - delivered),
                poId: r.po_id, poNum: r.po_num, poDate: r.po_date || '', poDue: r.po_due || '', poStatus: r.po_status || '',
                vendor: r.vendor || '', daysOpen: num(r.days_open), overdue: isTrue(r.overdue)
            };
            o.lines.push(line);
            o.units += line.pending;
            if (o.pos.indexOf(line.poNum) < 0) o.pos.push(line.poNum);
            if (line.vendor && o.vendors.indexOf(line.vendor) < 0) o.vendors.push(line.vendor);
            if (line.overdue) o.overdue = true;
            if (line.daysOpen > o.daysOpen) { o.daysOpen = line.daysOpen; o.oldestPo = line.poDate; }
            if (line.poDue && !o.receiveBy) o.receiveBy = line.poDue;
        });
        return [...map.values()];
    }

    /* ------------------------------------------------------------------ */
    /*  Read API                                                           */
    /* ------------------------------------------------------------------ */

    function getBoard() {
        const allowRelease = canRelease();
        const board = { release: [], dropship: [], ready: [], picked: [], packed: [], shipped: [], excluded: 0, channels: [], locations: [], canRelease: allowRelease };
        const channels = new Set();

        loadOrders().forEach((o) => {
            if (!o.openLines) {
                if (o.ignoredPos.length) board.excluded++;       // only lines with a PO left
                return;
            }
            if (o.channel) channels.add(o.channel);
            // An order can be in both lists: part released (Ready) and part still to release.
            if (!o.pending && o.pickUnits > 0 && !o.blocked) board.ready.push(o);
            if (allowRelease && (o.relLines > 0 || o.pending)) board.release.push(o);
        });
        attachBins(board.ready);
        if (board.release.length) attachStock(board.release);
        if (allowRelease) board.locations = getLocations();

        loadFulfillments().forEach((f) => {
            if (f.channel) channels.add(f.channel);
            if (f.shipStatus === SHIP.PICKED) board.picked.push(f);
            else if (f.shipStatus === SHIP.PACKED) board.packed.push(f);
            else if (f.shipStatus === SHIP.SHIPPED) board.shipped.push(f);
        });

        if (allowRelease) {
            board.dropship = loadDropship();
            board.dropship.forEach((o) => { if (o.channel) channels.add(o.channel); });
        }

        board.channels = [...channels].sort();
        return board;
    }

    // Read the actual fulfillment body cost; avoid guessing a SuiteQL column
    // or substituting the sales order's shipping charge.
    function getShippingCosts(ifIds) {
        const ids = [...new Set(toIds(ifIds))];
        if (ids.length > 25) throw new Error('Request up to 25 fulfillment costs at a time.');
        return ids.map((id) => {
            try {
                if (usage() < MIN_USAGE) throw new Error('Usage limit. Refresh to load this cost.');
                const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id, isDynamic: false });
                const value = rec.getValue({ fieldId: 'shippingcost' });
                const cost = value === '' || value == null ? null : Number(value);
                if (cost !== null && !Number.isFinite(cost)) throw new Error('Invalid shipping cost on fulfillment.');
                return { ifId: id, cost };
            } catch (e) {
                log.error({ title: 'WH Shipping | Read cost', details: { ifId: id, error: e.message } });
                return { ifId: id, cost: null, error: e.message };
            }
        });
    }

    function getFulfillmentDetail(ifId) {
        const id = toIds(ifId)[0];
        const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id });
        const lines = [];
        for (let i = 0; i < rec.getLineCount({ sublistId: 'item' }); i++) {
            if (!isTrue(rec.getSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i }))) continue;
            lines.push({
                itemId: num(rec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i })),
                sku: rec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }),
                name: rec.getSublistValue({ sublistId: 'item', fieldId: 'itemdescription', line: i }) || '',
                qty: num(rec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }))
            });
        }
        // Resolve display labels from the item record: fulfillment sublist text
        // can contain an internal ID and itemdescription can be empty.
        const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))];
        const labels = {};
        if (itemIds.length) {
            runSql(`SELECT id, itemid AS sku, NVL(displayname, itemid) AS name
                FROM item WHERE id IN (${qMarks(itemIds)}) ORDER BY id`, itemIds)
                .forEach((r) => { labels[r.id] = r; });
        }
        lines.forEach((l) => {
            const label = labels[l.itemId];
            if (label) { l.sku = label.sku; l.name = label.name || label.sku; }
        });
        const packages = readPackages(rec);
        return {
            ifId: id,
            ifNum: rec.getValue({ fieldId: 'tranid' }),
            shipStatus: rec.getValue({ fieldId: 'shipstatus' }),
            shippingCost: rec.getValue({ fieldId: 'shippingcost' }),
            shipVia: rec.getText({ fieldId: 'shipmethod' }) || '',
            shipTo: rec.getValue({ fieldId: 'shipaddress' }) || '',
            soId: rec.getValue({ fieldId: 'createdfrom' }),
            soNum: rec.getText({ fieldId: 'createdfrom' }) || '',
            labelPrinted: isTrue(rec.getValue({ fieldId: FLD.labelPrinted })),
            packageSublist: pkgSublist(rec),
            lines,
            packages,
            tracking: packages.map((p) => p.tracking).filter(Boolean)
        };
    }

    /* ------------------------------------------------------------------ */
    /*  Actions                                                            */
    /* ------------------------------------------------------------------ */

    function orderBlock(soId, picking = true) {
        const so = search.lookupFields({ type: search.Type.SALES_ORDER, id: soId,
            columns: [FLD.hold, FLD.doNotPick, 'tranid'] });
        if (isTrue(so[FLD.hold])) return `${so.tranid}: Hold / Do Not Release is checked.`;
        if (picking && isTrue(so[FLD.doNotPick])) return `${so.tranid}: Do Not Pick is checked.`;
        return '';
    }

    function assertOrderAllowed(soId, picking = true) {
        const reason = orderBlock(soId, picking);
        if (reason) throw new Error(reason);
    }

    /* ---------- release (line level, no commitment) ---------- */

    // Open / released numbers for the selected line of a dynamic SO
    function soLineState(so) {
        const get = (f) => so.getCurrentSublistValue({ sublistId: 'item', fieldId: f });
        const qty = num(get('quantity'));
        const ful = Math.abs(num(get('quantityfulfilled')));
        let pickedQty = ful;
        try { pickedQty = Math.max(ful, Math.abs(num(get('quantitypicked')))); } catch (e) { /* field not on form */ }
        const remaining = Math.max(0, qty - pickedQty);
        const rqRaw = get(FLD.releaseQty);
        return {
            qty, ful, pickedQty, remaining, rqSet: hasValue(rqRaw),
            rq: Math.min(Math.max(0, num(rqRaw)), remaining),
            location: String(get('location') || ''),
            createpo: get('createpo') || '',
            createdpo: get('createdpo'),
            itemId: get('item'),
            sku: so.getCurrentSublistText({ sublistId: 'item', fieldId: 'item' })
        };
    }

    // Orders released before line-level release: write the implicit released qty (whole open qty) onto the lines.
    // Returns true when lines were changed.
    function materializeLegacyRelease(so) {
        if (!isTrue(so.getValue({ fieldId: FLD.released }))) return false;
        const n = so.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < n; i++) {
            if (hasValue(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }))) return false;
        }
        let changed = false;
        for (let i = 0; i < n; i++) {
            so.selectLine({ sublistId: 'item', line: i });
            const s = soLineState(so);
            if (s.createdpo || !s.remaining) { so.cancelLine({ sublistId: 'item' }); continue; }
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, value: s.remaining });
            so.commitLine({ sublistId: 'item' });
            changed = true;
        }
        return changed;
    }

    /**
     * payload: { approve: boolean, lines: [{ lineId, location, releaseQty, createPo }] }
     *   approve    -> Pending Approval -> Pending Fulfillment (orderstatus B)
     *   location   -> line location (warehouse)
     *   releaseQty -> added to custcol_whc_release_qty (up to the open, unreleased qty)
     *   createPo   -> Pending Approval: line set to Drop Ship with the item vendor, NetSuite creates the linked PO on approval
     *                 Approved: only lines NetSuite already marked Drop Ship / Special Order (Create PO is locked after approval)
     */
    function releaseLines(soId, payload) {
        assertRelease();
        const body = Array.isArray(payload) ? { approve: false, lines: payload } : (payload || {});
        const id = toIds(soId)[0];
        const reqs = (body.lines || []).map((l) => ({
            lineId: String(l.lineId),
            location: l.location ? String(l.location) : '',
            r: Number(l.releaseQty) || 0,
            po: l.createPo === true || l.createPo === 'T'
        }));
        if (reqs.some((x) => x.r < 0)) throw new Error('Quantities must be positive.');
        if (reqs.some((x) => x.r > 0 && x.po)) throw new Error('A line can be released or sent to a PO, not both.');
        const releasing = reqs.some((x) => x.r > 0);
        const anyPo = reqs.some((x) => x.po);
        assertOrderAllowed(id, releasing);

        const so = record.load({ type: record.Type.SALES_ORDER, id, isDynamic: true });
        const tranid = so.getValue({ fieldId: 'tranid' });
        const pending = so.getValue({ fieldId: 'orderstatus' }) === 'A';
        if (pending && (releasing || anyPo) && !body.approve) {
            throw new Error(`${tranid}: set the status to Pending Fulfillment to release lines or create POs.`);
        }
        if (!pending && !reqs.length) throw new Error('Nothing to save.');

        let changed = false;
        if (pending) {
            // Start clean: clear release data copied onto the order or left from an earlier approval
            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                if (!hasValue(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }))) continue;
                so.selectLine({ sublistId: 'item', line: i });
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, value: '' });
                so.commitLine({ sublistId: 'item' });
                changed = true;
            }
            [FLD.released, FLD.printed].forEach((f) => {
                if (isTrue(so.getValue({ fieldId: f }))) { so.setValue({ fieldId: f, value: false }); changed = true; }
            });
            if (num(so.getValue({ fieldId: FLD.printCount }))) { so.setValue({ fieldId: FLD.printCount, value: 0 }); changed = true; }
        } else {
            changed = materializeLegacyRelease(so);
        }
        let released = 0;
        const poLines = [], newPoLines = [];
        const vendorCache = {};

        reqs.forEach((q) => {
            const idx = so.findSublistLineWithValue({ sublistId: 'item', fieldId: 'line', value: q.lineId });
            if (idx < 0) throw new Error(`${tranid}: a line is no longer on the order. Refresh and try again.`);
            so.selectLine({ sublistId: 'item', line: idx });
            const s = soLineState(so);
            let lineChanged = false;

            if (q.location && q.location !== s.location) {
                if (s.rq > 0 || s.pickedQty > 0) throw new Error(`${s.sku}: location can't change once qty is released or picked.`);
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: q.location });
                lineChanged = true;
            }

            if (q.po) {
                if (s.createdpo) throw new Error(`${s.sku}: this line already has a PO.`);
                if (pending) {
                    if (!(s.itemId in vendorCache)) vendorCache[s.itemId] = itemVendor(s.itemId);
                    const vendor = vendorCache[s.itemId];
                    if (!vendor) throw new Error(`${s.sku}: no vendor on the item. Add a preferred vendor to create a PO.`);
                    so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'createpo', value: 'DropShip' });
                    so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'povendor', value: vendor });
                    lineChanged = true;
                    newPoLines.push(q.lineId);
                } else if (s.createpo !== 'DropShip' && s.createpo !== 'SpecOrd') {
                    throw new Error(`${s.sku}: Create PO can't be set on an approved order. Only lines NetSuite already marked Drop Ship / Special Order can get a PO.`);
                }
                poLines.push(q.lineId);
            }

            if (q.r > 0) {
                const unreleased = s.remaining - s.rq;
                if (q.r > unreleased) throw new Error(`${s.sku}: ${q.r} requested but only ${unreleased} open and not released.`);
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, value: s.rq + q.r });
                released += q.r;
                lineChanged = true;
            }

            if (lineChanged) { so.commitLine({ sublistId: 'item' }); changed = true; }
            else so.cancelLine({ sublistId: 'item' });
        });

        let totalReleased = 0;
        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
            totalReleased += num(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }));
        }
        so.setValue({ fieldId: FLD.released, value: totalReleased > 0 });
        if (released > 0) {
            so.setValue({ fieldId: FLD.releasedBy, value: userId() });
            so.setValue({ fieldId: FLD.releasedOn, value: new Date() });
        }
        if (pending && body.approve) { so.setValue({ fieldId: 'orderstatus', value: 'B' }); changed = true; }

        if (changed) so.save({ enableSourcing: true, ignoreMandatoryFields: true });

        const result = { soId: id, tranid, released, approved: false, pos: [], skipped: [] };
        if (pending && body.approve) {
            const st = search.lookupFields({ type: search.Type.SALES_ORDER, id, columns: ['statusref'] }).statusref;
            const code = Array.isArray(st) ? (st[0] || {}).value : st;
            result.approved = code !== 'pendingApproval';
            if (!result.approved) {
                result.skipped.push({ reason: `${tranid}: saved, but NetSuite kept it Pending Approval. If approval runs through a workflow, approve it there.` });
            }
        }
        log.audit({ title: 'Release lines', details: { soId: id, tranid, approve: !!body.approve, released, poLines, newPoLines } });

        if (poLines.length && (result.approved || !pending)) {
            const po = createLinePOs(id, poLines);
            result.pos = po.pos;
            po.errors.forEach((e) => result.skipped.push({ reason: `${tranid}: ${e}` }));
        }
        return result;
    }

    /**
     * Makes sure the given SO lines have their PO. NetSuite normally creates it on approval;
     * otherwise this does the same as clicking the line link and saving:
     *   purchord.nl?soid=&specord=T|dropship=T&custid=&nexus=&subsidiary=&entity=&poentity=
     * One PO per type + vendor. NetSuite adds every open line of that type and vendor without a PO.
     */
    function createLinePOs(soId, lineIds) {
        const so = record.load({ type: record.Type.SALES_ORDER, id: soId });
        const base = {
            soid: soId,
            custid: so.getValue({ fieldId: 'entity' }),
            nexus: so.getValue({ fieldId: 'nexus' }),
            subsidiary: so.getValue({ fieldId: 'subsidiary' })
        };
        const want = new Set(lineIds.map(String));
        const pending = {}, linked = new Set(), errors = [];

        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
            if (!want.has(String(so.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i })))) continue;
            const createpo = so.getSublistValue({ sublistId: 'item', fieldId: 'createpo', line: i });
            const createdpo = so.getSublistValue({ sublistId: 'item', fieldId: 'createdpo', line: i });
            const sku = so.getSublistText({ sublistId: 'item', fieldId: 'item', line: i });
            if (createdpo) { linked.add(String(createdpo)); continue; }
            if (createpo !== 'DropShip' && createpo !== 'SpecOrd') { errors.push(`${sku}: not a Drop Ship / Special Order line.`); continue; }
            const itemId = so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            const vendor = so.getSublistValue({ sublistId: 'item', fieldId: 'povendor', line: i }) || itemVendor(itemId);
            if (!vendor) { errors.push(`${sku}: no vendor on the line or the item.`); continue; }
            pending[`${createpo}|${vendor}`] = { type: createpo, vendor };
        }

        Object.values(pending).forEach(({ type, vendor }) => {
            const label = type === 'DropShip' ? 'Dropship' : 'Special order';
            try {
                const defaults = Object.assign({}, base, { entity: vendor, poentity: vendor });
                if (type === 'DropShip') defaults.dropship = 'T'; else defaults.specord = 'T';
                Object.keys(defaults).forEach((k) => { if (!hasValue(defaults[k])) delete defaults[k]; });

                const po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true, defaultValues: defaults });
                if (!po.getLineCount({ sublistId: 'item' })) throw new Error('NetSuite returned no lines for this vendor.');
                const poId = po.save({ enableSourcing: true, ignoreMandatoryFields: true });
                linked.add(String(poId));
                log.audit({ title: 'PO created from SO', details: { soId, type, vendor, poId } });
            } catch (e) {
                log.error({ title: 'PO creation failed', details: { soId, type, vendor, error: e.message } });
                errors.push(`${label} PO for vendor ${vendor} not created (${e.message}).`);
            }
        });

        const pos = [...linked].map((poId) => {
            try { return search.lookupFields({ type: search.Type.PURCHASE_ORDER, id: poId, columns: ['tranid'] }).tranid; }
            catch (e) { return poId; }
        });
        return { pos, errors };
    }

    // Preferred vendor, else the first vendor on the item
    function itemVendor(itemId) {
        try {
            const rows = query.runSuiteQL({
                query: `SELECT iv.vendor AS vendor FROM itemvendor iv
                        WHERE iv.item = ? ORDER BY CASE WHEN iv.preferredvendor = 'T' THEN 0 ELSE 1 END`,
                params: [itemId]
            }).asMappedResults();
            return rows.length ? String(rows[0].vendor) : '';
        } catch (e) {
            log.audit({ title: 'Item vendor lookup failed', details: { itemId, error: e.message } });
            return '';
        }
    }

    // Bulk: release all open, unreleased qty on each order (approves Pending Approval orders; no PO)
    function release(soIds) {
        assertRelease();
        const ids = toIds(soIds);
        if (!ids.length) throw new Error('Select at least one order to release.');
        const released = [], skipped = [];
        loadOrders(ids).forEach((o) => {
            if (usage() < MIN_USAGE + 50) { skipped.push({ id: o.id, tranid: o.tranid, reason: `${o.tranid}: usage limit, release again.` }); return; }
            const blocked = orderBlock(o.id);
            if (blocked) { skipped.push({ id: o.id, tranid: o.tranid, reason: blocked }); return; }
            const lines = o.lines
                .filter((l) => !l.dropship && l.unreleased > 0)
                .map((l) => ({ lineId: l.lineId, releaseQty: l.unreleased, createPo: false }));
            if (!lines.length) { skipped.push({ id: o.id, tranid: o.tranid, reason: `${o.tranid}: nothing open to release.` }); return; }
            try {
                const r = releaseLines(o.id, { approve: o.pending, lines });
                released.push({ id: o.id, tranid: o.tranid, units: r.released });
                r.skipped.forEach((s) => skipped.push(s));
            } catch (e) {
                skipped.push({ id: o.id, tranid: o.tranid, reason: `${o.tranid}: ${e.message}` });
            }
        });
        return { released, skipped };
    }

    function unrelease(soId) {
        assertRelease();
        const id = toIds(soId)[0];
        const so = record.load({ type: record.Type.SALES_ORDER, id, isDynamic: true });
        if (isTrue(so.getValue({ fieldId: FLD.printed }))) {
            throw new Error(`${so.getValue({ fieldId: 'tranid' })}: picking ticket is already printed. It can't be sent back.`);
        }
        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
            if (!num(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }))) continue;
            so.selectLine({ sublistId: 'item', line: i });
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, value: 0 });
            so.commitLine({ sublistId: 'item' });
        }
        so.setValue({ fieldId: FLD.released, value: false });
        so.setValue({ fieldId: FLD.releasedBy, value: '' });
        so.setValue({ fieldId: FLD.releasedOn, value: null });
        so.save({ enableSourcing: false, ignoreMandatoryFields: true });
        return { id };
    }

    // After a fulfillment is saved: reduce released qty by what was picked.
    // The order stays in Ready to pick while released qty remains; a new ticket is required.
    function updateReleaseAfterPick(soId, want) {
        const so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        const n = so.getLineCount({ sublistId: 'item' });
        let lineLevel = false;
        for (let i = 0; i < n; i++) {
            if (hasValue(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }))) { lineLevel = true; break; }
        }
        if (!lineLevel) {
            // Legacy order: keep release approval, require a fresh ticket.
            record.submitFields({
                type: record.Type.SALES_ORDER, id: soId,
                values: { [FLD.released]: true, [FLD.printed]: false },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            return null;
        }
        Object.keys(want).forEach((lineId) => {
            const idx = so.findSublistLineWithValue({ sublistId: 'item', fieldId: 'line', value: lineId });
            if (idx < 0) return;
            so.selectLine({ sublistId: 'item', line: idx });
            const rq = num(so.getCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty }));
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, value: Math.max(0, rq - want[lineId].qty) });
            so.commitLine({ sublistId: 'item' });
        });
        let remaining = 0;
        for (let i = 0; i < n; i++) remaining += num(so.getSublistValue({ sublistId: 'item', fieldId: FLD.releaseQty, line: i }));
        so.setValue({ fieldId: FLD.released, value: remaining > 0 });
        so.setValue({ fieldId: FLD.printed, value: false });
        so.save({ enableSourcing: false, ignoreMandatoryFields: true });
        return remaining;
    }

    function markPrinted(soIds) {
        const ids = toIds(soIds);
        if (!ids.length) throw new Error('Select at least one order to print.');
        const done = [];
        ids.forEach((id) => {
            if (usage() < MIN_USAGE) return;
            const so = search.lookupFields({ type: search.Type.SALES_ORDER, id, columns: [FLD.released, FLD.printCount, 'tranid'] });
            if (!isTrue(so[FLD.released])) throw new Error(`${so.tranid} is not released to the warehouse.`);
            assertOrderAllowed(id);
            const count = num(so[FLD.printCount]) + 1;
            record.submitFields({
                type: record.Type.SALES_ORDER, id,
                values: { [FLD.printed]: true, [FLD.printedBy]: userId(), [FLD.printedOn]: new Date(), [FLD.printCount]: count },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            done.push({ id, tranid: so.tranid, count });
        });
        return { printed: done };
    }

    function buildPickTickets(soIds) {
        const ids = toIds(soIds);
        const orders = loadOrders(ids).filter((o) => o.released && o.pickLines);
        if (!orders.length) throw new Error('No released lines to print.');
        orders.forEach((o) => assertOrderAllowed(o.id));
        attachBins(orders);

        const now = new Date().toLocaleString();
        const user = runtime.getCurrentUser().name;
        const pdfs = orders.map((o) => {
            const lines = o.lines
                .filter((l) => !l.dropship && l.committed > 0)
                .sort((a, b) => String(a.bin).localeCompare(String(b.bin)));
            const backorder = o.lines.filter((l) => !l.dropship && l.remaining > l.committed);
            const rows = lines.map((l) => `
                <tr>
                    <td class="bin">${xmlEsc(l.bin || '-')}</td>
                    <td>${xmlEsc(l.name)}<br/><span class="sku">${xmlEsc(l.sku)}</span></td>
                    <td align="center" class="qty">${l.committed}</td>
                    <td align="center"><table class="box"><tr><td>&nbsp;</td></tr></table></td>
                </tr>`).join('');
            const reprint = o.printCount > 1
                ? `<table class="reprint"><tr><td>REPRINT ${o.printCount}</td></tr></table>` : '';
            const notes = [];
            if (backorder.length) notes.push(`${backorder.length} line(s) have qty not released to the warehouse; only released qty is listed.`);
            if (o.ignoredPos.length) notes.push(`Dropship lines with PO (${o.ignoredPos.join(', ')}) are not on this ticket.`);
            if (o.awaitingPo) notes.push(`${o.awaitingPo} dropship line(s) awaiting PO are not on this ticket.`);

            return `
<pdf>
<head>
<style type="text/css">
    body { font-family: Helvetica, sans-serif; font-size: 10pt; }
    h1 { font-size: 20pt; margin: 0; }
    th { background-color: #e8ecf1; font-weight: bold; padding: 6px; border-bottom: 1px solid #888; }
    td { padding: 6px; border-bottom: 0.5px solid #ccc; vertical-align: middle; }
    td.bin { font-size: 12pt; font-weight: bold; }
    td.qty { font-size: 13pt; font-weight: bold; }
    span.sku { font-size: 8pt; color: #555; }
    table.box td { width: 14px; height: 14px; border: 1.2px solid #000; padding: 0; }
    table.reprint td { border: 2px solid #000; font-weight: bold; padding: 3px 8px; }
    table.hdr td, table.info td { border-bottom: 0; padding: 2px 0; }
    table.sign td { border-bottom: 0; border-top: 1px solid #000; font-size: 8pt; }
</style>
</head>
<body size="Letter" padding="0.45in 0.5in 0.45in 0.5in">
    <table class="hdr" width="100%"><tr>
        <td width="60%"><h1>Picking ticket</h1>Printed ${xmlEsc(now)} by ${xmlEsc(user)}${reprint}</td>
        <td width="40%" align="right"><barcode codetype="code128" showtext="true" value="${xmlEsc(o.tranid)}"/></td>
    </tr></table>
    <table class="info" width="100%" style="margin-top:12px"><tr>
        <td width="40%"><b>Ship to</b><br/>${xmlEsc(o.customer)}<br/>${xmlEsc(o.shipTo).replace(/\r?\n/g, '<br/>')}</td>
        <td width="20%"><b>Ship via</b><br/>${xmlEsc(o.shipVia)}</td>
        <td width="20%"><b>Channel</b><br/>${xmlEsc(o.channel)}</td>
        <td width="20%"><b>Order date</b><br/>${xmlEsc(o.date)}</td>
    </tr></table>
    <table width="100%" style="margin-top:14px">
        <thead><tr><th width="16%">Bin</th><th width="56%">Item</th><th width="14%" align="center">Qty</th><th width="14%" align="center">Picked</th></tr></thead>
        ${rows}
    </table>
    ${notes.map((n) => `<p style="margin-top:8px">${xmlEsc(n)}</p>`).join('')}
    <table class="sign" width="100%" style="margin-top:30px"><tr>
        <td width="45%">Picked by</td><td width="10%" style="border-top:0">&nbsp;</td><td width="45%">Date and time</td>
    </tr></table>
</body>
</pdf>`;
        }).join('');

        const xml = `<?xml version="1.0"?>\n<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">\n<pdfset>${pdfs}</pdfset>`;
        const file = render.xmlToPdf({ xmlString: xml });
        file.name = `PickingTickets_${Date.now()}.pdf`;
        return file;
    }

    function setBin(ifRec, line, itemId, qty, bins, sku) {
        const b = bins[itemId];
        if (!b || !b.binId) throw new Error(`${sku}: no preferred bin at this location. Set one on the item or pick on the fulfillment record.`);
        const det = ifRec.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line });
        for (let j = det.getLineCount({ sublistId: 'inventoryassignment' }) - 1; j >= 0; j--) {
            det.removeLine({ sublistId: 'inventoryassignment', line: j });
        }
        det.insertLine({ sublistId: 'inventoryassignment', line: 0 });
        det.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', line: 0, value: b.binId });
        det.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: qty });
    }

    function pick(soId, lines) {
        const id = toIds(soId)[0];
        assertOrderAllowed(id);
        const so = search.lookupFields({ type: search.Type.SALES_ORDER, id, columns: [FLD.released, FLD.printed, 'tranid'] });
        if (!isTrue(so[FLD.released])) throw new Error(`${so.tranid} is not released to the warehouse.`);
        if (!isTrue(so[FLD.printed])) throw new Error(`Print the picking ticket for ${so.tranid} before marking it picked.`);

        const order = loadOrders([id])[0];
        if (!order) throw new Error(`${so.tranid} has no open warehouse lines.`);

        const byLine = {};
        order.lines.forEach((l) => { byLine[String(l.lineId)] = l; });

        const want = {};
        (lines || []).forEach((l) => {
            const q = num(l.qty);
            const src = byLine[String(l.lineId)];
            if (q <= 0 || !src) return;
            if (src.dropship) throw new Error(`${src.sku} is a dropship line and can't be picked.`);
            if (q > src.committed) throw new Error(`${src.sku}: ${q} picked but only ${src.committed} released to the warehouse.`);
            want[String(l.lineId)] = { qty: q, src };
        });
        if (!Object.keys(want).length) throw new Error('Check at least one line with a quantity before marking picked.');

        const needBins = getPreferredBins([...new Set(Object.values(want).map((w) => w.src.itemId))]);

        // Carrier-specific package layout is selected during transformation.
        // Set the source order first; changing a generic IF afterwards is blocked.
        const shippingSetup = search.lookupFields({ type: search.Type.SALES_ORDER, id,
            columns: ['shipmethod', 'shipcarrier'] });
        const methodRef = shippingSetup.shipmethod;
        const sourceMethod = Array.isArray(methodRef) ? String((methodRef[0] || {}).value || '') : String(methodRef || '');
        if (sourceMethod !== '54302') {
            shippingLog('audit', 'Pick: initialize source shipping', { soId: id, previousShipMethod: sourceMethod,
                targetShipMethod: 54302, targetCarrier: 'nonups' });
            record.submitFields({
                type: record.Type.SALES_ORDER, id,
                values: { shipcarrier: 'nonups', shipmethod: 54302 },
                options: { enableSourcing: false, ignoreMandatoryFields: false }
            });
            shippingLog('audit', 'Pick: source shipping updated', { soId: id, shipMethod: 54302,
                note: 'Source order shipping method is retained even if subsequent fulfillment creation fails.' });
        }

        const ifRec = record.transform({
            fromType: record.Type.SALES_ORDER, fromId: id,
            toType: record.Type.ITEM_FULFILLMENT, isDynamic: false
        });

        const initializedMethod = String(ifRec.getValue({ fieldId: 'shipmethod' }));
        const initializedPackages = pkgSublist(ifRec);
        shippingLog('audit', 'Pick: fulfillment shipping initialized', { soId: id,
            shipMethod: initializedMethod, packageSublist: initializedPackages });
        if (initializedMethod !== '54302' || initializedPackages !== 'packagefedex') {
            throw new Error('The sales order shipping method is FedEx Ground (54302), but NetSuite did not initialize FedEx package details on the new fulfillment. No new fulfillment was saved. Review the source order shipping setup.');
        }
        // Label generation remains part of the later packed/rating workflow.
        ifRec.setValue({ fieldId: 'generateintegratedshipperlabel', value: false });

        let matched = 0;
        for (let i = 0; i < ifRec.getLineCount({ sublistId: 'item' }); i++) {
            const orderLine = String(ifRec.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
            const w = want[orderLine];
            if (!w) {
                ifRec.setSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i, value: false });
                continue;
            }
            ifRec.setSublistValue({ sublistId: 'item', fieldId: 'itemreceive', line: i, value: true });
            ifRec.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: w.qty });
            if (isTrue(ifRec.getSublistValue({ sublistId: 'item', fieldId: 'inventorydetailreq', line: i }))) {
                setBin(ifRec, i, w.src.itemId, w.qty, needBins, w.src.sku);
            }
            matched++;
        }
        if (matched !== Object.keys(want).length) {
            throw new Error('Some lines are no longer open on the order. Refresh and try again.');
        }

        ifRec.setValue({ fieldId: 'shipstatus', value: SHIP.PICKED });
        const ifId = ifRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
        shippingLog('audit', 'Pick: FedEx fulfillment saved', { soId: id, ifId, shipMethod: 54302, status: SHIP.PICKED, lines: matched });

        const ifNum = search.lookupFields({ type: search.Type.ITEM_FULFILLMENT, id: ifId, columns: ['tranid'] }).tranid;
        const result = { ifId, ifNum, soId: id, lines: matched, releasedRemaining: null };

        // Reduce released qty by what was picked; require a fresh ticket for the next pick.
        try {
            result.releasedRemaining = updateReleaseAfterPick(id, want);
        } catch (e) {
            log.error({ title: 'Pick: release qty update failed', details: { soId: id, ifId, error: e.message } });
            result.skipped = [{ reason: `${ifNum} was created, but the released qty on ${so.tranid} could not be updated (${e.message}). Check the order lines before the next pick.` }];
        }
        return result;
    }

    function pack(ifId, packages) {
        const id = toIds(ifId)[0];
        const pk = packages || [];
        if (!Array.isArray(pk) || !pk.length || pk.some((p) => !p || !Number.isFinite(Number(p.weight)) || Number(p.weight) <= 0)) {
            throw new Error('Every package must have a weight greater than zero.');
        }

        const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id, isDynamic: false });
        assertOrderAllowed(rec.getValue({ fieldId: 'createdfrom' }), false);
        const status = rec.getValue({ fieldId: 'shipstatus' });
        if (status !== SHIP.PICKED) throw new Error('Only a picked fulfillment can be packed. Refresh the queue.');

        const sub = pkgSublist(rec);
        if (!sub) throw new Error('No package sublist on this fulfillment. Check the ship method.');
        const f = PKG[sub];

        const axes = ['length','width','height'];
        const fedex = sub === 'packagefedex';
        if (fedex && pk.some(p => !p.dimensions || axes.some(k => !Number.isFinite(Number(p.dimensions[k])) || Number(p.dimensions[k]) <= 0))) {
            throw new Error('Enter a positive length, width and height in inches.');
        }
        const count = r => r.getLineCount({sublistId:sub});
        const val = (r,i,fieldId) => r.getSublistValue({sublistId:sub,line:i,fieldId});
        const write = (r,i,fieldId,value) => r.setSublistValue({sublistId:sub,line:i,fieldId,value});
        const tracked = r => Array.from({length:count(r)}, (_,i)=>val(r,i,f.tracking)).some(Boolean);
        if (tracked(rec)) throw new Error('This fulfillment already has tracking. Review its packages before packing.');
        rec.setValue({ fieldId: 'shipstatus', value: SHIP.PACKED });
        pk.forEach((p,i) => {
            if (i >= count(rec)) rec.insertLine({sublistId:sub,line:i});
            write(rec,i,f.weight,Number(p.weight));
            if (fedex) axes.forEach(k=>write(rec,i,'package'+k+'fedex',Number(p.dimensions[k])));
            if (f.descr && p.descr) write(rec,i,f.descr,String(p.descr).slice(0,300));
        });
        const trim = r => { for(let i=count(r)-1;i>=pk.length;i--) r.removeLine({sublistId:sub,line:i}); };
        trim(rec);
        rec.save({enableSourcing:false,ignoreMandatoryFields:true});
        const reload = () => record.load({type:record.Type.ITEM_FULFILLMENT,id,isDynamic:false});
        const matches = r => pkgSublist(r) === sub && r.getValue({fieldId:'shipstatus'}) === SHIP.PACKED &&
            pk.every((p,i)=>i<count(r) && Number(val(r,i,f.weight))===Number(p.weight) &&
                (!fedex || axes.every(k=>Number(val(r,i,'package'+k+'fedex'))===Number(p.dimensions[k]))));
        let saved = reload();
        // A status-change default can appear only after save. Correct trailing extras once,
        // only when all intended rows survived and no carrier tracking exists.
        if (matches(saved) && count(saved)>pk.length && !tracked(saved)) {
            trim(saved); saved.save({enableSourcing:false,ignoreMandatoryFields:true}); saved=reload();
        }
        if (!matches(saved) || count(saved)!==pk.length) throw new Error('Fulfillment '+id+' was saved, but its packages differ from your entry. Review the fulfillment before calculating a rate or label.');
        return { ifId: id, packages: pk.length };
    }

    // Server execution logs only. Native browser calculation/download errors
    // cannot reach this library unless the browser sends a subsequent request.
    // Logging must never interrupt fulfillment processing.
    function shippingLog(level, step, details) {
        try { log[level]({ title: 'WH Shipping | ' + step, details }); }
        catch (ignored) { /* Preserve the original operation if logging fails. */ }
    }

    function loggedShippingAction(action, fn, describe, summarize) {
        return function () {
            const started = Date.now();
            const details = describe.apply(null, arguments);
            shippingLog('audit', action + ' START', details);
            try {
                const result = fn.apply(null, arguments);
                shippingLog('audit', action + ' COMPLETE', Object.assign({}, details,
                    summarize(result), { elapsedMs: Date.now() - started }));
                return result;
            } catch (e) {
                shippingLog('error', action + ' FAILED', Object.assign({}, details, {
                    elapsedMs: Date.now() - started, errorName: e.name || 'Error',
                    errorMessage: e.message || String(e)
                }));
                throw e;
            }
        };
    }

    function shippingCostContext(ifId) {
        const id = toIds(ifId)[0];
        if (!id) throw new Error('Select a fulfillment.');
        const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id, isDynamic: false });
        shippingLog('audit', 'Cost record loaded', {
            ifId: id, soId: rec.getValue({ fieldId: 'createdfrom' }),
            status: rec.getValue({ fieldId: 'shipstatus' }), carrier: rec.getValue({ fieldId: 'shipcarrier' }),
            shipMethod: rec.getValue({ fieldId: 'shipmethod' }), currentCost: rec.getValue({ fieldId: 'shippingcost' })
        });
        if (rec.getValue({ fieldId: 'shipstatus' }) !== SHIP.PACKED) throw new Error('Shipping cost can only be calculated for a packed fulfillment.');
        assertOrderAllowed(rec.getValue({ fieldId: 'createdfrom' }), false);
        const packages = readPackages(rec);
        if (!packages.length || packages.some((p) => !Number.isFinite(Number(p.weight)) || Number(p.weight) <= 0)) {
            throw new Error('Enter a positive weight for every package on the fulfillment first.');
        }
        shippingLog('audit', 'Cost package validation passed', { ifId: id, packageSublist: pkgSublist(rec),
            packageCount: packages.length, weights: packages.map((p) => p.weight) });
        const hasTracking = packages.some((p) => String(p.tracking || '').trim());
        if (hasTracking && String(rec.getValue({ fieldId: 'shipmethod' })) !== '54302') {
            throw new Error('This fulfillment already has tracking for another service. Review its label on the native fulfillment before changing the shipping method.');
        }
        return { id, rec, packages };
    }

    // Internal NetSuite UI endpoint, not a documented SuiteScript rating API.
    // The caller's session is forwarded only to this account's application host.
    // Never log request headers, cookies, raw XML, or native response bodies.
    function calculateShippingCost(ifId, requestHeaders) {
        const c = shippingCostContext(ifId);
        const existingMethod = String(c.rec.getValue({ fieldId: 'shipmethod' }));
        const packageType = pkgSublist(c.rec);
        shippingLog('audit', 'Backend cost: carrier layout preflight', {
            ifId: c.id, existingMethod, targetMethod: 54302, packageSublist: packageType
        });
        // This is a native record-layout limitation, not a shipcarrier-value check.
        // A reload of N/record does not convert generic/UPS packages into FedEx.
        if (existingMethod !== '54302' && packageType !== 'packagefedex') {
            throw new Error('Fulfillment ' + c.id + ' has ' + (packageType || 'no') +
                ' package details. NetSuite cannot switch this existing fulfillment to FedEx Ground (54302) through this backend update. ' +
                'It must first be initialized with the FedEx shipping method. No fulfillment changes or rate request were made.');
        }
        const headers = requestHeaders || {};
        const cookieKey = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie');
        if (!cookieKey || !headers[cookieKey]) {
            throw new Error('NetSuite did not expose the authenticated session to the Suitelet. The backend native shipping URL cannot be called. No fulfillment changes were made.');
        }
        let updated = false;
        try {
            // First persist the shipping setup, as requested. Keep mandatory-field
            // validation enabled and reload before building the rating request.
            const previousMethod = String(c.rec.getValue({ fieldId: 'shipmethod' }));
            if (previousMethod !== '54302') c.rec.setValue({ fieldId: 'shipmethod', value: 54302 });
            c.rec.setValue({ fieldId: 'generateintegratedshipperlabel', value: true });
            if (previousMethod !== '54302') c.rec.setValue({ fieldId: FLD.labelPrinted, value: false });
            shippingLog('audit', 'Backend cost: update IF', { ifId: c.id, previousMethod, shipMethod: 54302, generateIntegratedLabel: true });
            c.rec.save({ enableSourcing: true, ignoreMandatoryFields: false });
            updated = true;
            const current = shippingCostContext(c.id);
            if (String(current.rec.getValue({ fieldId: 'shipmethod' })) !== '54302' ||
                !isTrue(current.rec.getValue({ fieldId: 'generateintegratedshipperlabel' }))) {
                throw new Error('NetSuite did not retain the requested shipping method and integrated-label setting.');
            }
            // Do not silently calculate using package weights changed by sourcing.
            if (JSON.stringify(current.packages.map((p) => Number(p.weight))) !==
                JSON.stringify(c.packages.map((p) => Number(p.weight)))) {
                throw new Error('NetSuite changed the package rows or weights during the update. Review package details before calculating again.');
            }
            const requestXml = buildBackendRatesXml(current.rec);
            const domain = url.resolveDomain({ hostType: url.HostType.APPLICATION });
            const endpoint = 'https://' + domain + '/app/common/shipping/dynshippingxml.nl?jrr=T';
            shippingLog('audit', 'Backend cost: rate request', { ifId: c.id,
                endpoint: '/app/common/shipping/dynshippingxml.nl?jrr=T', method: 'remoteObject.getShippingRates',
                packageCount: current.packages.length, requestCharacters: requestXml.length });
            const response = https.post({
                url: endpoint,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Cookie': headers[cookieKey] },
                body: JSON.stringify({ id: 1, method: 'remoteObject.getShippingRates', params: [requestXml] })
            });
            shippingLog('audit', 'Backend cost: rate response', { ifId: c.id, httpStatus: response.code,
                responseCharacters: String(response.body || '').length });
            if (Number(response.code) !== 200) {
                throw new Error('Native shipping URL returned HTTP ' + response.code + '. Backend session authentication or the rate request was rejected.');
            }
            let rpc;
            try { rpc = JSON.parse(response.body); }
            catch (e) { throw new Error('Native shipping URL returned a non-JSON page, possibly a login page. Backend session authentication must be verified.'); }
            if (rpc.error) throw new Error('Native shipping service returned an RPC error. Check native shipping configuration and session access.');
            if (typeof rpc.result !== 'string') throw new Error('Native shipping service returned no rates XML.');
            const doc = xml.Parser.fromString({ text: rpc.result });
            const shipments = xml.XPath.select({ node: doc, xpath: '/RatesResponse/Shipments/Shipment' });
            if (shipments.length !== 1) throw new Error('Expected one shipment rate; NetSuite returned ' + shipments.length + '.');
            const value = (name) => {
                const nodes = xml.XPath.select({ node: shipments[0], xpath: './' + name });
                return nodes.length ? String(nodes[0].textContent || '').trim() : '';
            };
            const error = value('ErrorMessage');
            if (error) throw new Error('Shipping rate failed: ' + error);
            const rateText = value('ShippingRate');
            const rate = Number(rateText);
            if (!rateText || !Number.isFinite(rate) || rate < 0) throw new Error('NetSuite returned an invalid shipping rate.');
            if (value('ShippingMethodKey') && value('ShippingMethodKey') !== '54302') throw new Error('NetSuite returned a rate for a different shipping method.');
            const cost = Math.round((rate + Number.EPSILON) * 100) / 100;
            shippingLog('audit', 'Backend cost: rate accepted', { ifId: c.id, rate, roundedCost: cost, currency: value('CurrencyCode') });
            // Rebuild only the inputs actually sent to the native rate service.
            return saveShippingCost(c.id, requestXml, cost);
        } catch (e) {
            if (e.name === 'CANT_SWITCH_SHIP_METHOD' || /Switching the shipping method to another carrier/i.test(e.message || '')) {
                shippingLog('error', 'Backend cost: native carrier switch blocked', {
                    ifId: c.id, existingMethod, targetMethod: 54302, packageSublist: packageType,
                    settingsSaveCompleted: updated, errorName: e.name, errorMessage: e.message
                });
                throw new Error('NetSuite blocked switching fulfillment ' + c.id +
                    ' to FedEx Ground (54302): CANT_SWITCH_SHIP_METHOD. This existing fulfillment requires a carrier form reload, ' +
                    'which this backend-only flow cannot perform. No popup was opened. Review its shipping setup before retrying.');
            }
            if (updated) throw new Error('Shipping settings were saved on fulfillment ' + c.id + ', but rate calculation/save did not finish: ' + e.message + ' Review the fulfillment before retrying.');
            throw e;
        }
    }

    function buildBackendRatesXml(rec) {
        const fields = rec.getFields();
        const get = (name) => fields.indexOf(name) >= 0 ? rec.getValue({ fieldId: name }) : '';
        const str = (value) => value === true ? 'T' : value === false ? 'F' : value == null ? '' : value;
        const tag = (name, value) => '<' + name + '>' + xmlEsc(str(value)) + '</' + name + '>';
        const tags = (obj) => Object.keys(obj).map((key) => tag(key, obj[key])).join('');
        const address = rec.getSubrecord({ fieldId: 'shippingaddress' });
        const addr = (name) => address.getValue({ fieldId: name }) || '';
        if (!addr('country') || (addr('country') === 'US' && !addr('zip'))) throw new Error('Destination country and ZIP are required for shipping rates.');
        const so = record.load({ type: record.Type.SALES_ORDER, id: get('createdfrom'), isDynamic: false });
        const soFields = so.getFields();
        const soGet = (name) => soFields.indexOf(name) >= 0 ? so.getValue({ fieldId: name }) : '';
        const currency = get('currency') || soGet('currency');
        if (!currency) throw new Error('Transaction currency could not be resolved.');
        const body = {
            RequestSrc: 'FULFILLMENT', RatesCarrier: 'fedexRealTimeRate', EntityId: get('entity'), IsItemLineRates: 'false',
            DestCity: addr('city'), DestState: addr('state'), DestZip: addr('zip'), DestCountry: addr('country'),
            ShipMethod: '54302', SalesOrderId: get('createdfrom'), ShipStatus: get('shipstatus'),
            IsResidential: str(address.getValue({ fieldId: 'isresidential' }) || false), IsThirdPartyAcct: 'F',
            ThirdPartyCarrier: '', IsPackagesReload: 'false', IsDefaultRequest: 'false', Currency: currency,
            TransactionFxRate: get('exchangerate') || soGet('exchangerate') || 1, Subsidiary: get('subsidiary'),
            TestId: get('testid'), NexusId: get('nexus') || soGet('nexus'), OverrideShippingCost: '', IsDynamicScriptingRequest: 'false'
        };
        const shipmentFields = {
            ReasonForExport:'reasonforexportfedex',TermsOfSale:'termsofsalefedex',TermsFreightCharge:'termsfreightchargefedex',
            TermsInsuranceCharge:'termsinsurancechargefedex',DutyPaymentType:'dutypaymenttypefedex',DutyPaymentAcct:'dutypaymentacctfedex',
            B13AFilingOption:'b13afilingoptionfedex',B13AStatementData:'b13astatementdatafedex',IntlExemptionNumber:'intlexemptionnumfedex',
            ShipDate:'shipdatefedex',IsSaturdayDelivery:'saturdaydeliveryfedex',IsSaturdayPickup:'saturdaypickupfedex',
            HoldAtLocation:'holdatlocationfedex',HALAddr1:'haladdr1fedex',HALAddr2:'haladdr2fedex',HALAddr3:'haladdr3fedex',
            HALCity:'halcityfedex',HALPhone:'halphonefedex',HALLocationPhone:'hallocationphonefedex',HALState:'halstatefedex',HALCountry:'halcountryfedex',HALZip:'halzipfedex'
        };
        Object.keys(shipmentFields).forEach((key) => {
            let v = get(shipmentFields[key]);
            if (v instanceof Date) v = format.format({ value: v, type: format.Type.DATE });
            body[key] = v;
        });
        // Use the persisted FedEx package details after the first save.
        if (rec.getSublists().indexOf('packagefedex') < 0) throw new Error('FedEx package details were not sourced. Update the package details on the fulfillment.');
        const subFields = rec.getSublistFields({ sublistId: 'packagefedex' });
        const pkg = (name, line) => subFields.indexOf(name) < 0 ? '' : rec.getSublistValue({ sublistId: 'packagefedex', fieldId: name, line });
        const packages = [];
        for (let i = 0; i < rec.getLineCount({ sublistId: 'packagefedex' }); i++) {
            const weight = Number(pkg('packageweightfedex', i));
            if (!Number.isFinite(weight) || weight <= 0) throw new Error('Every FedEx package requires a positive weight.');
            packages.push('<Package>' + tags({
                PackageNumber: i + 1, PackageLength: pkg('packagelengthfedex', i) || 12,
                PackageWidth: pkg('packagewidthfedex', i) || 12, PackageHeight: pkg('packageheightfedex', i) || 3,
                PackageWeight: weight, PackageType: pkg('packagingfedex', i) || '-1',
                PackageInsuredValue: isTrue(pkg('useinsuredvaluefedex', i)) ? pkg('insuredvaluefedex', i) : '',
                PackageSignatureOption: String(pkg('deliveryconffedex', i)) === '5' ? pkg('signatureoptionsfedex', i) : '',
                AdditionalHandling: '', UseCOD: pkg('usecodfedex', i), CODAmount: pkg('codamountfedex', i), CODMethod: pkg('codmethodfedex', i),
                DeliveryConfirmation: '', DryIceWeight: pkg('dryiceweightfedex', i), DryIceUnit: pkg('dryiceweightunitfedex', i),
                CODTransportationCharges: pkg('codfreighttypefedex', i), CODOtherCharge: pkg('codotherchargefedex', i)
            }) + '</Package>');
        }
        if (!packages.length) throw new Error('No FedEx packages were found after updating the fulfillment.');
        const itemFields = rec.getSublistFields({ sublistId: 'item' });
        const item = (name, line) => itemFields.indexOf(name) < 0 ? '' : rec.getSublistValue({ sublistId: 'item', fieldId: name, line });
        const sourceFields = so.getSublistFields({ sublistId: 'item' });
        const source = (name, line) => sourceFields.indexOf(name) < 0 ? '' : so.getSublistValue({ sublistId: 'item', fieldId: name, line });
        const sourceLines = {};
        for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) sourceLines[String(source('line', i))] = i;
        const locations = new Set(), items = [];
        for (let i = 0; i < rec.getLineCount({ sublistId: 'item' }); i++) {
            if (!isTrue(item('itemreceive', i)) || item('kitmemberof', i)) continue;
            const quantity = Number(item('quantity', i));
            if (!(quantity > 0)) continue;
            const location = item('location', i) || get('location');
            if (!location) throw new Error('A fulfillment item is missing its shipping location.');
            locations.add(String(location));
            const sourceLine = sourceLines[String(item('orderline', i))];
            if (sourceLine === undefined) throw new Error('Unable to match a fulfillment item to its sales order line.');
            const sourceQty = Number(source('quantity', sourceLine));
            const amount = Number(source('amount', sourceLine));
            if (!(sourceQty > 0) || !Number.isFinite(amount)) throw new Error('Sales order line quantity/amount is invalid.');
            items.push('<Item>' + tags({ ItemQuantity: quantity, ItemAmount: quantity * amount / sourceQty,
                ItemWeight: Number(item('itemweight', i) || 0) * quantity, ItemKey: item('item', i), ItemLocation: location,
                ItemUnits: item('units', i), ItemType: item('itemtype', i), ItemLine: item('line', i),
                ItemTotalQuantity: sourceQty, ItemQuantityRemaining: item('quantityremaining', i), ItemTotalAmount: amount
            }) + '</Item>');
        }
        if (locations.size !== 1 || !items.length) throw new Error('Native rates require fulfillment items from one shipping location.');
        return '<RatesRequest>' + tags(body) + '<Packages>' + packages.join('') + '</Packages><Items>' + items.join('') + '</Items></RatesRequest>';
    }

    // Compare the deterministic request payload, not NetSuite's record wrapper.
    // Request values never appear in logs (they include address information).
    function changedRateInputs(beforeXml, afterXml) {
        const fields = (text) => {
            const result = {}, counts = {};
            const leaf = /<([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/\1>/g;
            let match;
            while ((match = leaf.exec(text || '')) !== null) {
                const name = match[1];
                counts[name] = (counts[name] || 0) + 1;
                result[name + '[' + counts[name] + ']'] = match[2];
            }
            return result;
        };
        const before = fields(beforeXml), after = fields(afterXml);
        return [...new Set(Object.keys(before).concat(Object.keys(after)))]
            .filter((key) => before[key] !== after[key]);
    }

    function saveShippingCost(ifId, expectedRatesXml, shippingCost) {
        if (typeof shippingCost !== 'number' || !Number.isFinite(shippingCost) || shippingCost < 0) {
            throw new Error('NetSuite must return a valid shipping cost.');
        }
        const c = shippingCostContext(ifId);
        const currentRatesXml = buildBackendRatesXml(c.rec);
        const changedInputs = changedRateInputs(expectedRatesXml, currentRatesXml);
        const matches = !!expectedRatesXml && currentRatesXml === expectedRatesXml;
        shippingLog('audit', 'Cost rate inputs checked', { ifId: c.id, matches, changedInputs });
        if (!matches) {
            throw new Error('Shipping-rate inputs changed during calculation' +
                (changedInputs.length ? ': ' + changedInputs.join(', ') : '.') +
                '. Calculate again to use the current shipping details.');
        }
        const oldMethod = String(c.rec.getValue({ fieldId: 'shipmethod' }));
        if (oldMethod !== '54302') c.rec.setValue({ fieldId: 'shipmethod', value: 54302 });
        c.rec.setValue({ fieldId: 'generateintegratedshipperlabel', value: true });
        c.rec.setValue({ fieldId: 'shippingcost', value: shippingCost });
        if (oldMethod !== '54302') c.rec.setValue({ fieldId: FLD.labelPrinted, value: false });
        // Values come from the completed native calculation; do not re-source them.
        shippingLog('audit', 'Cost save requested', { ifId: c.id, oldShipMethod: oldMethod, newShipMethod: 54302,
            shippingCost, generateIntegratedLabel: true, labelReadyFlagReset: oldMethod !== '54302' });
        c.rec.save({ enableSourcing: false, ignoreMandatoryFields: false });
        shippingLog('audit', 'Cost record saved; verifying', { ifId: c.id });
        const saved = record.load({ type: record.Type.ITEM_FULFILLMENT, id: c.id, isDynamic: false });
        const savedCost = Number(saved.getValue({ fieldId: 'shippingcost' }));
        shippingLog('audit', 'Cost saved values', { ifId: c.id, requestedCost: shippingCost, savedCost,
            savedShipMethod: saved.getValue({ fieldId: 'shipmethod' }),
            generateIntegratedLabel: saved.getValue({ fieldId: 'generateintegratedshipperlabel' }) });
        if (!Number.isFinite(savedCost) || Math.abs(savedCost - shippingCost) > 0.000001 ||
            String(saved.getValue({ fieldId: 'shipmethod' })) !== '54302') {
            throw new Error('The save completed, but NetSuite changed the rate or shipping method. Refresh and review the fulfillment before retrying.');
        }
        return { ifId: c.id, shippingCost: savedCost };
    }

    // Prepare native label retrieval. Opening a print URL is not proof of success.
    function printLabel(ifIds) {
        const ids = [...new Set(toIds(ifIds))];
        if (!ids.length) throw new Error('Select at least one fulfillment.');
        const labels = [], skipped = [];
        ids.forEach((id) => {
            if (usage() < MIN_USAGE) {
                shippingLog('audit', 'Label skipped: usage limit', { ifId: id, remainingUsage: usage() });
                skipped.push({ ifId: id, reason: 'Usage limit. Try this fulfillment again.' });
                return;
            }
            try {
                const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id, isDynamic: false });
                shippingLog('audit', 'Label record loaded', { ifId: id,
                    status: rec.getValue({ fieldId: 'shipstatus' }), carrier: rec.getValue({ fieldId: 'shipcarrier' }),
                    shipMethod: rec.getValue({ fieldId: 'shipmethod' }), packageSublist: pkgSublist(rec) });
                const soId = toIds(rec.getValue({ fieldId: 'createdfrom' }))[0];
                if (!soId) throw new Error('Sales order not found.');
                assertOrderAllowed(soId, false);
                const status = rec.getValue({ fieldId: 'shipstatus' });
                if (status !== SHIP.PACKED && status !== SHIP.SHIPPED) throw new Error('Pack this fulfillment first.');
                const packages = readPackages(rec);
                if (!packages.length || packages.some((p) => !Number.isFinite(Number(p.weight)) || Number(p.weight) <= 0)) {
                    throw new Error('Enter a positive weight for every package on the fulfillment first.');
                }
                // Native FedEx ZPL still requires FedEx package details, without a carrier-value restriction.
                if (pkgSublist(rec) !== 'packagefedex') {
                    throw new Error('This label download supports native FedEx ZPL. Open the fulfillment for other carriers.');
                }
                shippingLog('audit', 'Label URL prepared', { ifId: id, soId, packageCount: packages.length,
                    weights: packages.map((p) => p.weight), printType: 'fedexshippinglabel',
                    nextStep: 'Browser retrieves ZPL; label-ready flag is not set by preparation.' });
                labels.push({
                    ifId: id, soId, ifNum: rec.getValue({ fieldId: 'tranid' }) || String(id),
                    editUrl: url.resolveRecord({ recordType: record.Type.ITEM_FULFILLMENT, recordId: id, isEditMode: true }),
                    url: '/app/accounting/print/hotprint.nl?regular=T&sethotprinter=T&id=' + soId +
                        '&label=UPS%20Shipping%20Labels&printtype=fedexshippinglabel&trantype=itemship&auxtrans=' + id
                });
            } catch (e) {
                shippingLog('error', 'Label preparation skipped', { ifId: id, errorName: e.name || 'Error', reason: e.message });
                skipped.push({ ifId: id, reason: e.message });
            }
        });
        return { labels, skipped };
    }

    // Called only after the browser has retrieved and validated the complete ZPL.
    // This flag means label file ready, not confirmation of a physical printer job.
    function labelDownloaded(ifId, zpl) {
        if (typeof zpl !== 'string' || zpl.length > 5000000 ||
            !/\^XA[\s\S]*\^XZ/.test(zpl) || /<html|<!doctype/i.test(zpl)) {
            throw new Error('A valid ZPL label is required.');
        }
        shippingLog('audit', 'Browser ZPL received and validated', { ifId: toIds(ifId)[0],
            zplCharacters: zpl.length, note: 'Valid syntax reported by browser; not a physical printer confirmation.' });
        const result = printLabel([ifId]);
        if (!result.labels.length) throw new Error((result.skipped[0] || {}).reason || 'Fulfillment not available.');
        const id = result.labels[0].ifId;
        shippingLog('audit', 'Label-ready flag save requested', { ifId: id, field: FLD.labelPrinted, value: true });
        record.submitFields({
            type: record.Type.ITEM_FULFILLMENT, id,
            values: { [FLD.labelPrinted]: true },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
        return { ifId: id };
    }

    function ship(ifIds) {
        const ids = toIds(ifIds);
        if (!ids.length) throw new Error('Select at least one fulfillment.');
        const shipped = [], skipped = [];
        ids.forEach((id) => {
            if (usage() < MIN_USAGE) { skipped.push({ ifId: id, reason: 'Usage limit, ship again' }); return; }
            const rec = record.load({ type: record.Type.ITEM_FULFILLMENT, id, isDynamic: false });
            const ifNum = rec.getValue({ fieldId: 'tranid' });
            if (rec.getValue({ fieldId: 'shipstatus' }) !== SHIP.PACKED) { skipped.push({ ifId: id, ifNum, reason: 'Not packed' }); return; }
            if (!isTrue(rec.getValue({ fieldId: FLD.labelPrinted }))) { skipped.push({ ifId: id, ifNum, reason: 'Label not printed' }); return; }
            const blocked = orderBlock(rec.getValue({ fieldId: 'createdfrom' }), false);
            if (blocked) { skipped.push({ ifId: id, ifNum, reason: blocked }); return; }
            if (!readPackages(rec).some((p) => String(p.tracking || '').trim())) {
                skipped.push({ ifId: id, ifNum, reason: 'Tracking number required' }); return;
            }
            rec.setValue({ fieldId: 'shipstatus', value: SHIP.SHIPPED });
            rec.save({ enableSourcing: true, ignoreMandatoryFields: true });
            shipped.push({ ifId: id, ifNum });
        });
        return { shipped, skipped };
    }

    function packingSlip(soId, ifId) {
        const opts = { entityId: toIds(soId)[0], printMode: render.PrintMode.PDF };
        const fId = toIds(ifId)[0];
        if (fId) opts.fulfillmentId = fId;
        return render.packingSlip(opts);
    }

    return {
        FLD,
        diagnose,
        stockCheck,
        getOrderStock,
        canRelease,
        getBoard,
        getFulfillmentDetail,
        getShippingCosts,
        release,
        releaseLines,
        unrelease,
        markPrinted,
        buildPickTickets,
        pick,
        pack,
        calculateShippingCost: loggedShippingAction('Backend cost', calculateShippingCost,
            (ifId) => ({ ifId: toIds(ifId)[0] || null }),
            (r) => ({ ifId: r.ifId, savedCost: r.shippingCost })),
        printLabel: loggedShippingAction('Label prepare', printLabel,
            (ifIds) => ({ ifIds: toIds(ifIds) }),
            (r) => ({ preparedIds: r.labels.map((l) => l.ifId), skipped: r.skipped })),
        labelDownloaded: loggedShippingAction('Label confirm', labelDownloaded,
            (ifId, zpl) => ({ ifId: toIds(ifId)[0] || null,
                zplCharacters: typeof zpl === 'string' ? zpl.length : 0 }),
            (r) => ({ ifId: r.ifId, labelReady: true })),
        ship,
        packingSlip
    };
});