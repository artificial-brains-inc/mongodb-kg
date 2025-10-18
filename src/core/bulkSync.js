// src/bulkSync.js
const { getCtx } = require('./init');

/**
 * kgBulkSync
 *
 * Dual-purpose:
 *  1. Classic bulk upsert (desiredNodes / desiredEdges)
 *  2. Fast resync using model bindings (useBindings: true)
 */
async function kgBulkSync(opts = {}) {
  const {
    desiredNodes = [],
    desiredEdges = [],
    keepExtra = { edges: true }, // default: DO NOT PRUNE
    models = [],
    maxPerModel = 0,
    useBindings = false,
    batchSize = 1000,
  } = opts;

  const { nodesModel, edgesModel } = getCtx();
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit() must be called before kgBulkSync()');
  }

  // ------------------------------------------------------------------
  // FAST PATH: Resync using bindings (no touching source collections)
  // ------------------------------------------------------------------
  if (useBindings && Array.isArray(models) && models.length > 0) {
    let totalNodes = 0;
    let totalEdges = 0;

    for (const { model, query = {}, label = (model && model.modelName) || 'Model' } of models) {
      if (!model?.find) {
        throw new Error('kgBulkSync(useBindings): each entry must be { model }');
      }

      const binding = model.__kgBinding || model?.schema?.statics?.__kgBinding;
      if (!binding) {
        console.warn(`[kgBulkSync] No __kgBinding found for ${label}; skipping`);
        continue;
      }

      const { buildNode, buildEdges } = binding;
      const cursor = model.find(query).lean().cursor();

      let nodeBuf = [];
      let edgeBuf = [];
      let processed = 0;

      async function flush() {
        if (!nodeBuf.length && !edgeBuf.length) return;
        const nops = nodeBuf.map(n => ({
          updateOne: { filter: { id: n.id }, update: { $set: n }, upsert: true },
        }));
        const eops = edgeBuf.map(e => ({
          updateOne: { filter: { id: e.id }, update: { $set: e }, upsert: true },
        }));

        if (nops.length) await nodesModel.bulkWrite(nops, { ordered: false });
        if (eops.length) await edgesModel.bulkWrite(eops, { ordered: false });

        totalNodes += nops.length;
        totalEdges += eops.length;

        nodeBuf = [];
        edgeBuf = [];
      }

      for await (const doc of cursor) {
        if (typeof buildNode === 'function') {
          const n = await Promise.resolve(buildNode(doc, ctx));
          if (n?.id) nodeBuf.push(n);
        }
        if (typeof buildEdges === 'function') {
          const es = await Promise.resolve(buildEdges(doc, ctx));
          if (Array.isArray(es) && es.length) edgeBuf.push(...es.filter(Boolean));
        }

        processed++;
        if (maxPerModel && processed >= maxPerModel) break;
        if (nodeBuf.length + edgeBuf.length >= batchSize) {
          await flush();
        }
      }

      await flush();
      // console.log(`[kgBulkSync][bindings] ${label} processed=${processed}`);
    }

    return { mode: 'bindings', upsertedNodes: totalNodes, upsertedEdges: totalEdges };
  }

  // ------------------------------------------------------------------
  // CLASSIC BULK UPSERT (backward compatible)
  // ------------------------------------------------------------------
  const nodeOps = desiredNodes.map(node => ({
    updateOne: {
      filter: { id: node.id },
      update: { $set: node },
      upsert: true,
    },
  }));

  const edgeOps = desiredEdges.map(edge => ({
    updateOne: {
      filter: { id: edge.id },
      update: { $set: edge },
      upsert: true,
    },
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
      id: { $nin: Array.from(desiredEdgeIds) },
    });
  }

  return {
    mode: 'bulk',
    upsertedNodes: desiredNodes.length,
    upsertedEdges: desiredEdges.length,
  };
}

module.exports = { kgBulkSync };
