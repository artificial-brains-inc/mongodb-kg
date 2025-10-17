const { getCtx } = require('./init');

const defaultOnError = (err, context = {}) => {
  const { label = 'Model', operation = 'operation', docId } = context;
  const idPart = docId !== undefined ? ` (docId=${docId})` : '';
  console.error(`[kgBulkSync][${label}] ${operation} failed${idPart}: ${err.message}`);
};

async function kgBulkSync(opts = {}) {
  const {
    desiredNodes = [],
    desiredEdges = [],
    keepExtra = { edges: true },
    models = [],
    mode = 'save',
    concurrency = 8,
    maxPerModel = 0,
    onError: onErrorOption
  } = opts;

  const onError = onErrorOption === null
    ? null
    : (typeof onErrorOption === 'function' ? onErrorOption : defaultOnError);

  function reportError(err, meta, errorsByLabel, failureCounts) {
    const label = meta?.label || 'Model';
    const docId = meta?.docId;
    const operation = meta?.operation || 'operation';

    if (!errorsByLabel[label]) {
      errorsByLabel[label] = [];
    }
    errorsByLabel[label].push({
      docId,
      operation,
      name: err.name,
      message: err.message,
      stack: err.stack
    });

    failureCounts[label] = (failureCounts[label] || 0) + 1;

    if (onError) {
      try {
        onError(err, { label, docId, operation });
      } catch (handlerErr) {
        console.error('[kgBulkSync] onError handler threw:', handlerErr);
      }
    }
  }

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
    const errorsByLabel = {};
    const failureCounts = {};

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
      const pending = () => processed + inFlight.size;

      if (mode === 'save') {
        // Load full docs to run post('save')
        const cursor = Model.find(query).lean(false).cursor();
        for await (const doc of cursor) {
          const docId = doc?._id?.toString?.() ?? doc?._id;
          const op = (async () => {
            doc.set('__kg_touch', new Date());
            await doc.save();
            processed++;
          })().catch(err => {
            reportError(err, { label, docId, operation: 'save' }, errorsByLabel, failureCounts);
          }).finally(() => {
            inFlight.delete(op);
          });

          inFlight.add(op);
          if (inFlight.size >= concurrency) await Promise.race(inFlight);
          if (maxPerModel && pending() >= maxPerModel) break;
        }
        await Promise.allSettled([...inFlight]);

      } else if (mode === 'findOneAndUpdate') {
        // Per-document FOU so hooks fire
        const idCursor = Model.find(query).select({ _id: 1 }).lean().cursor();
        for await (const d of idCursor) {
          const docId = d?._id?.toString?.() ?? d?._id;
          const p = Model.findOneAndUpdate(
            { _id: d._id },
            { $set: { __kg_touch: new Date() } },
            { new: true }
          ).then(() => {
            processed++;
          }).catch(err => {
            reportError(err, { label, docId, operation: 'findOneAndUpdate' }, errorsByLabel, failureCounts);
          }).finally(() => {
            inFlight.delete(p);
          });

          inFlight.add(p);
          if (inFlight.size >= concurrency) await Promise.race(inFlight);
          if (maxPerModel && pending() >= maxPerModel) break;
        }
        await Promise.allSettled([...inFlight]);

      } else {
        throw new Error(`kgBulkSync(models): unsupported mode "${mode}"`);
      }

      results[label] = processed;
    }

    const response = { mode: 'resync', processed: results };
    if (Object.keys(errorsByLabel).length > 0) {
      response.failures = failureCounts;
      response.errors = errorsByLabel;
    }
    return response;
  }

  // ---------- CLASSIC BULK UPSERT ----------
  const dedupeById = (records = []) => {
    const map = new Map();
    for (const record of records) {
      if (record && record.id) {
        map.set(record.id, record);
      }
    }
    return Array.from(map.values());
  };

  const uniqueNodes = dedupeById(desiredNodes);
  const uniqueEdges = dedupeById(desiredEdges);

  const nodeOps = uniqueNodes.map(node => ({
    updateOne: { filter: { id: node.id }, update: { $set: node }, upsert: true }
  }));
  const edgeOps = uniqueEdges.map(edge => ({
    updateOne: { filter: { id: edge.id }, update: { $set: edge }, upsert: true }
  }));

  if (nodeOps.length) await nodesModel.bulkWrite(nodeOps, { ordered: false });
  if (edgeOps.length) await edgesModel.bulkWrite(edgeOps, { ordered: false });

  const edgesKeepExtra = typeof keepExtra === 'object' ? !!keepExtra.edges : !!keepExtra;
  if (!edgesKeepExtra && uniqueNodes.length > 0) {
    const controlledSources = Array.from(new Set(uniqueNodes.map(n => n.id)));
    const desiredEdgeIds = new Set(uniqueEdges.map(e => e.id));
    await edgesModel.deleteMany({ source: { $in: controlledSources }, id: { $nin: Array.from(desiredEdgeIds) } });
  }

  return {
    mode: 'bulk',
    upsertedNodes: uniqueNodes.length,
    upsertedEdges: uniqueEdges.length
  };
}

module.exports = { kgBulkSync };
