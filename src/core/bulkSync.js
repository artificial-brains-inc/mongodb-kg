const { getCtx } = require('./init');

/**
 * kgBulkSync
 *
 * Backwards compatible:
 *  - If you pass desiredNodes/desiredEdges: performs classic bulk upserts.
 *  - If you pass models: re-triggers middleware on existing docs to sync the graph.
 *
 * @param {Object} opts
 * @param {Array<Object>} [opts.desiredNodes=[]]
 * @param {Array<Object>} [opts.desiredEdges=[]]
 * @param {boolean|{nodes?:boolean,edges?:boolean}} [opts.keepExtra={edges:true}]
 * @param {Array<{model:any, query?:object, label?:string}>} [opts.models=[]]
 * @param {'save'|'findOneAndUpdate'} [opts.mode='save']
 * @param {number} [opts.concurrency=8]
 * @param {number} [opts.maxPerModel=0] // 0 = all
 * @returns {Promise<Object>} summary
 */
async function kgBulkSync(opts = {}) {
  const {
    desiredNodes = [],
    desiredEdges = [],
    keepExtra = { edges: true }, // default safe: no prune
    models = [],
    mode = 'save',
    concurrency = 8,
    maxPerModel = 0,
  } = opts;

  const { nodesModel, edgesModel } = getCtx();
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit() must be called before kgBulkSync()');
  }

  // utility: ensure we can "touch" docs under strict schemas
  function ensureTouchPath(Model) {
    if (!Model.schema.path('__kg_touch')) {
      Model.schema.add({ __kg_touch: { type: Date, default: null } });
    }
  }

  // small p-limit helper without deps
  function createLimiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active < max && queue.length) {
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
          .then(fn)
          .then((v) => { active--; resolve(v); next(); })
          .catch((e) => { active--; reject(e); next(); });
      }
    };
    return (fn) =>
      new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
  }

  // -----------------------------
  // Branch 1: RESYNC via models[]
  // -----------------------------
  if (Array.isArray(models) && models.length > 0) {
    const results = {};
    const LOG_EVERY = 200; // progress cadence

    for (const item of models) {
      if (!item || !item.model || typeof item.model.find !== 'function') {
        throw new Error('kgBulkSync(models): each entry must be { model: MongooseModel, query?, label? }');
      }

      const Model = item.model;
      const query = item.query || {};
      const label = item.label || Model.modelName || 'Model';

      ensureTouchPath(Model);

      let processed = 0;
      const limit = createLimiter(concurrency);

      if (mode === 'save') {
        // Load full docs so post('save') hooks fire
        const cursor = Model.find(query).lean(false).cursor();

        try {
          for await (const doc of cursor) {
            // Touch a known path so Mongoose considers it modified
            doc.set('__kg_touch', new Date());

            // Limit concurrency
            await limit(async () => {
              try { await doc.save(); }
              catch { /* swallow per-doc errors for throughput */ }
              processed++;
              if (processed % LOG_EVERY === 0) {
                console.log(`[kgBulkSync][${label}] save processed=${processed}`);
              }
            });

            if (maxPerModel && processed >= maxPerModel) break;
          }
        } finally {
          // cursor will auto-close on loop exit, but this is explicit
          if (cursor && typeof cursor.close === 'function') {
            try { await cursor.close(); } catch {}
          }
        }

        // Drain any remaining tasks
        // (our limiter drains automatically as promises resolve)

      } else if (mode === 'findOneAndUpdate') {
        // We MUST call findOneAndUpdate to trigger post('findOneAndUpdate') hooks.
        const ids = [];
        const cursor = Model.find(query).select({ _id: 1 }).lean().cursor();

        try {
          for await (const d of cursor) {
            ids.push(d._id);
            if (maxPerModel && processed + ids.length >= maxPerModel) break;

            if (ids.length >= 500) {
              // process this batch with concurrency limit
              await Promise.all(ids.map((_id) =>
                limit(() =>
                  Model.findOneAndUpdate(
                    { _id },
                    { $set: { __kg_touch: new Date() } },
                    { new: true, strict: false } // strict false to avoid stripping unknown path
                  ).catch(() => {})
                )
              ));
              processed += ids.length;
              console.log(`[kgBulkSync][${label}] f1u processed=${processed}`);
              ids.length = 0;
            }
          }
        } finally {
          if (cursor && typeof cursor.close === 'function') {
            try { await cursor.close(); } catch {}
          }
        }

        if (ids.length) {
          await Promise.all(ids.map((_id) =>
            limit(() =>
              Model.findOneAndUpdate(
                { _id },
                { $set: { __kg_touch: new Date() } },
                { new: true, strict: false }
              ).catch(() => {})
            )
          ));
          processed += ids.length;
          console.log(`[kgBulkSync][${label}] f1u processed=${processed}`);
        }
      } else {
        throw new Error(`kgBulkSync(models): unsupported mode "${mode}"`);
      }

      results[label] = processed;
    }
    return { mode: 'resync', processed: results };
  }

  // --------------------------------------------
  // Branch 2: CLASSIC BULK UPSERT (back-compat)
  // --------------------------------------------
  const nodeOps = desiredNodes.map(node => ({
    updateOne: { filter: { id: node.id }, update: { $set: node }, upsert: true }
  }));

  const edgeOps = desiredEdges.map(edge => ({
    updateOne: { filter: { id: edge.id }, update: { $set: edge }, upsert: true }
  }));

  if (nodeOps.length) await nodesModel.bulkWrite(nodeOps);
  if (edgeOps.length) await edgesModel.bulkWrite(edgeOps);

  // Optional pruning (NO org_id dependency)
  const edgesKeepExtra = typeof keepExtra === 'object' ? !!keepExtra.edges : !!keepExtra;
  if (!edgesKeepExtra && desiredNodes.length > 0) {
    const controlledSources = Array.from(new Set(desiredNodes.map(n => n.id)));
    const desiredEdgeIds = new Set(desiredEdges.map(e => e.id));
    await edgesModel.deleteMany({
      source: { $in: controlledSources },
      id: { $nin: Array.from(desiredEdgeIds) }
    });
  }

  return { mode: 'bulk', upsertedNodes: desiredNodes.length, upsertedEdges: desiredEdges.length };
}

module.exports = { kgBulkSync };
