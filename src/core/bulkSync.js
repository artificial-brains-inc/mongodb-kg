const { getCtx } = require('./init');

/**
 * kgBulkSync
 *
 * Backwards compatible:
 *  - If you pass desiredNodes/desiredEdges: performs classic bulk upserts.
 *  - If you pass models: re-triggers middleware on existing docs to sync the graph.
 *
 * @param {Object} opts
 * @param {Array<Object>} [opts.desiredNodes=[]]   Classic bulk: nodes to upsert (must include stable `id`)
 * @param {Array<Object>} [opts.desiredEdges=[]]   Classic bulk: edges to upsert (must include stable `id`)
 * @param {boolean|{nodes?:boolean,edges?:boolean}} [opts.keepExtra={edges:true}]
 *        - For classic bulk only. When edges=false, we prune edges whose `source`
 *          is one of the provided nodes and whose id is NOT in desiredEdges.
 *          Default is edges:true (NO PRUNE) for safety.
 *
 * @param {Array<{model:any, query?:object, label?:string}>} [opts.models=[]]
 *        - NEW: If provided, we "touch" docs in these models to fire your bindModel hooks.
 * @param {'save'|'findOneAndUpdate'} [opts.mode='save']   // resync mode
 * @param {number} [opts.concurrency=8]                    // resync: parallel saves
 * @param {number} [opts.maxPerModel=0]                    // resync: 0 means "all"
 *
 * @returns {Promise<Object>} summary (classic: counts; resync: per-model processed)
 */
async function kgBulkSync(opts = {}) {
  const {
    desiredNodes = [],
    desiredEdges = [],
    keepExtra = { edges: true },       // default: DO NOT PRUNE
    models = [],                       // NEW resync path
    mode = 'save',
    concurrency = 8,
    maxPerModel = 0,
  } = opts;

  const { nodesModel, edgesModel } = getCtx();
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit() must be called before kgBulkSync()');
  }

  // -----------------------------
  // Branch 1: RESYNC via models[]
  // -----------------------------
  if (Array.isArray(models) && models.length > 0) {
    const results = {};
    for (const item of models) {
      if (!item || !item.model || typeof item.model.find !== 'function') {
        throw new Error('kgBulkSync(models): each entry must be { model: MongooseModel, query?, label? }');
      }
      const Model = item.model;
      const query = item.query || {};
      const label = item.label || Model.modelName || 'Model';

      let processed = 0;

      if (mode === 'save') {
        // Use full documents so post('save') middleware fires
        const cursor = Model.find(query).lean(false).cursor();
        const inFlight = new Set();

        for await (const doc of cursor) {
          // touch a field to ensure modified state (some hooks check modifiedPaths)
          doc.set('__kg_touch', new Date());

          const p = doc.save().then(() => {
            processed++;
            inFlight.delete(p);
          }).catch((err) => {
            inFlight.delete(p);
            // Swallow per-doc errors but continue; you can log if you want:
            // console.error(`[kgBulkSync][${label}] save failed`, err);
          });

          inFlight.add(p);
          if (inFlight.size >= concurrency) {
            await Promise.race(inFlight);
          }
          if (maxPerModel && processed >= maxPerModel) break;
        }
        await Promise.allSettled([...inFlight]);
      } else if (mode === 'findOneAndUpdate') {
        // Faster, if you have post('findOneAndUpdate') wiring too
        const ids = [];
        for await (const d of Model.find(query).select({ _id: 1 }).lean().cursor()) {
          ids.push(d._id);
          if (maxPerModel && processed + ids.length >= maxPerModel) break;
          if (ids.length >= 500) {
            await Promise.all(ids.map(_id =>
              Model.findOneAndUpdate({ _id }, { $set: { __kg_touch: new Date() } }, { new: true })
            ));
            processed += ids.length;
            ids.length = 0;
          }
        }
        if (ids.length) {
          await Promise.all(ids.map(_id =>
            Model.findOneAndUpdate({ _id }, { $set: { __kg_touch: new Date() } }, { new: true })
          ));
          processed += ids.length;
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
    updateOne: {
      filter: { id: node.id },
      update: { $set: node },
      upsert: true
    }
  }));

  const edgeOps = desiredEdges.map(edge => ({
    updateOne: {
      filter: { id: edge.id },
      update: { $set: edge },
      upsert: true
    }
  }));

  if (nodeOps.length) {
    await nodesModel.bulkWrite(nodeOps);
  }
  if (edgeOps.length) {
    await edgesModel.bulkWrite(edgeOps);
  }

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

  return {
    mode: 'bulk',
    upsertedNodes: desiredNodes.length,
    upsertedEdges: desiredEdges.length
  };
}

module.exports = { kgBulkSync };
