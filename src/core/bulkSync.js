const { getCtx } = require('./init');

async function kgBulkSync(opts = {}) {
  const {
    desiredNodes = [],
    desiredEdges = [],
    keepExtra = { edges: true },
    models = [],
    mode = 'save',
    concurrency = 8,
    maxPerModel = 0,
  } = opts;

  const { nodesModel, edgesModel } = getCtx();
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit() must be called before kgBulkSync()');
  }

  function ensureTouchPath(Model) {
    if (!Model.schema.path('__kg_touch')) {
      Model.schema.add({ __kg_touch: { type: Date, default: null } });
    }
  }

  // ---------- RESYNC PATH ----------
  if (Array.isArray(models) && models.length > 0) {
    const results = {};

    for (const item of models) {
      if (!item || !item.model || typeof item.model.find !== 'function') {
        throw new Error('kgBulkSync(models): each entry must be { model: MongooseModel, query?, label? }');
      }
      const Model = item.model;
      const query = item.query || {};
      const label = item.label || Model.modelName || 'Model';

      ensureTouchPath(Model);

      let processed = 0;
      const inFlight = new Set();

      if (mode === 'save') {
        // Load full docs to run post('save')
        const cursor = Model.find(query).lean(false).cursor();
        for await (const doc of cursor) {
          doc.set('__kg_touch', new Date());
          const p = doc.save()
            .then(() => { processed++; inFlight.delete(p); })
            .catch(() => { inFlight.delete(p); });

          inFlight.add(p);
          if (inFlight.size >= concurrency) await Promise.race(inFlight);
          if (maxPerModel && processed >= maxPerModel) break;
        }
        await Promise.allSettled([...inFlight]);

      } else if (mode === 'findOneAndUpdate') {
        // Per-document FOU so hooks fire
        const idCursor = Model.find(query).select({ _id: 1 }).lean().cursor();
        for await (const d of idCursor) {
          const p = Model.findOneAndUpdate(
            { _id: d._id },
            { $set: { __kg_touch: new Date() } },
            { new: true }
          ).then(() => { processed++; inFlight.delete(p); })
           .catch(() => { inFlight.delete(p); });

          inFlight.add(p);
          if (inFlight.size >= concurrency) await Promise.race(inFlight);
          if (maxPerModel && processed >= maxPerModel) break;
        }
        await Promise.allSettled([...inFlight]);

      } else {
        throw new Error(`kgBulkSync(models): unsupported mode "${mode}"`);
      }

      results[label] = processed;
      // optional: console.log(`[kgBulkSync][${label}] ${mode} processed=${processed}`);
    }

    return { mode: 'resync', processed: results };
  }

  // ---------- CLASSIC BULK UPSERT ----------
  const nodeOps = desiredNodes.map(node => ({
    updateOne: { filter: { id: node.id }, update: { $set: node }, upsert: true }
  }));
  const edgeOps = desiredEdges.map(edge => ({
    updateOne: { filter: { id: edge.id }, update: { $set: edge }, upsert: true }
  }));

  if (nodeOps.length) await nodesModel.bulkWrite(nodeOps);
  if (edgeOps.length) await edgesModel.bulkWrite(edgeOps);

  const edgesKeepExtra = typeof keepExtra === 'object' ? !!keepExtra.edges : !!keepExtra;
  if (!edgesKeepExtra && desiredNodes.length > 0) {
    const controlledSources = Array.from(new Set(desiredNodes.map(n => n.id)));
    const desiredEdgeIds = new Set(desiredEdges.map(e => e.id));
    await edgesModel.deleteMany({ source: { $in: controlledSources }, id: { $nin: Array.from(desiredEdgeIds) } });
  }

  return { mode: 'bulk', upsertedNodes: desiredNodes.length, upsertedEdges: desiredEdges.length };
}

module.exports = { kgBulkSync };
