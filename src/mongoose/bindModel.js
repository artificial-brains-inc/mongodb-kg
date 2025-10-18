const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

const BIND_FLAG = Symbol.for('kg:bindModel:bound');

function bindModel(modelOrSchema, config = {}) {
  console.log('bindModel called');
  if (!config || (typeof config.node !== 'function' && typeof config.edges !== 'function')) {
    throw new Error('bindModel() requires at least one of: node(doc) or edges(doc)');
  }
  console.log('called 1');
  const isSchema =
    modelOrSchema &&
    typeof modelOrSchema.post === 'function' &&
    typeof modelOrSchema.add === 'function' &&
    !('modelName' in modelOrSchema);

  const schema = isSchema ? modelOrSchema : modelOrSchema?.schema;

  if (!schema || typeof schema.post !== 'function') {
    throw new Error('bindModel(): pass a Mongoose Model or Schema');
  }



  if (!schema || typeof schema.post !== 'function') {
    throw new Error('bindModel(): pass a Mongoose Model or Schema');
  }

  if (schema[BIND_FLAG]) {
    return modelOrSchema;
  }
  schema[BIND_FLAG] = true;

    // If a Model was passed, keep it; if a Schema was passed, Model stays null.
  const Model = modelOrSchema && typeof modelOrSchema.find === 'function' ? modelOrSchema : null;


    // === Attach distance helpers ============================================
    if (!schema.statics.kgShortestPath) {
      schema.statics.kgShortestPath = async function(aId, bId, opts = {}) {
        const { edgesModel } = getCtx();
        return _bfsShortestPath({ aId, bId, edgesModel, ...opts });
      };
    }
    if (!schema.statics.kgWeightedPath) {
      schema.statics.kgWeightedPath = async function(aId, bId, opts = {}) {
        const { edgesModel } = getCtx();
        return _dijkstraWeightedPath({ aId, bId, edgesModel, ...opts });
      };
    }
    // If a concrete Model instance was passed in, mirror the statics on it too
    if (Model) {
      if (!Model.kgShortestPath) Model.kgShortestPath = schema.statics.kgShortestPath;
      if (!Model.kgWeightedPath) Model.kgWeightedPath = schema.statics.kgWeightedPath;
    }

    if (Model && !Model.kgRecommend) {
      Model.kgRecommend = schema.statics.kgRecommend;
    }
    // ========================================================================


  const {
    node: buildNode,
    edges: buildEdges,
    cleanup: buildCleanup,
    keepExtra,
    onError
  } = config;

  schema.statics.__kgBinding = { buildNode, buildEdges, buildCleanup };
  if (Model) {
    Model.__kgBinding = schema.statics.__kgBinding;
  }

  const reportHookError = typeof onError === 'function'
    ? (err, hook) => {
        try {
          onError(err, hook);
        } catch (handlerErr) {
          console.error('[bindModel onError handler]', handlerErr);
        }
      }
    : (err, hook) => {
        console.error(`[bindModel ${hook}]`, err);
      };

  const defaultKeepExtra = keepExtra !== undefined ? keepExtra : { edges: true };

  async function buildNodeSafe(doc) {
    if (typeof buildNode !== 'function') return null; // edges-only
    const node = await Promise.resolve(buildNode(doc));
    if (!node || !node.id) {
      const idForLog = doc && doc._id ? String(doc._id) : '(no _id)';
      throw new Error(`bindModel node(doc) must return an object with an id (model=${schema?.options?.collection || 'unknown'}, _id=${idForLog})`);
    }
    return node;
  }

  async function buildEdgesSafe(doc) {
    if (!buildEdges) return [];
    const edges = await Promise.resolve(buildEdges(doc, getCtx()));
    if (!Array.isArray(edges)) return [];
    return edges.filter(Boolean);
  }

  async function buildCleanupFilters(doc, node) {
    if (typeof buildCleanup === 'function') {
      const filters = await Promise.resolve(buildCleanup(doc, getCtx()));
      if (Array.isArray(filters) && filters.length > 0) return filters;
    }
    // Default fallback: only if we actually have a node
    return node ? [{ source: node.id }, { target: node.id }, { id: node.id }] : [];
  }

  async function syncDoc(doc, hookName) {
    if (!doc) return;
    try {
      const node  = await buildNodeSafe(doc);          // may be null
      const edges = await buildEdgesSafe(doc);         // []
      await kgBulkSync({
        desiredNodes: node ? [node] : [],
        desiredEdges: edges,
        // With no node, we can’t “control” a source → never prune by default
        keepExtra: defaultKeepExtra
      });
    } catch (err) {
      reportHookError(err, hookName);
    }
  }

  async function cleanupDoc(doc, hookName) {
    if (!doc) return;
    try {
      const node = await buildNodeSafe(doc);                 // may be null
      const { nodesModel, edgesModel } = getCtx();
      if (!nodesModel || !edgesModel) {
        throw new Error('kgInit() must be called before using bindModel()');
      }

      const filters = await buildCleanupFilters(doc, node);

      if (filters.length > 0) {
        await edgesModel.deleteMany({ $or: filters });
      } else {
        // Edges-only binding without cleanup: nothing deterministic to delete.
        // Intentionally do nothing.
      }

      if (node) {
        await nodesModel.deleteOne({ id: node.id });
      }
    } catch (err) {
      reportHookError(err, hookName);
    }
  }

  const getQueryFilter = (query) => {
    if (!query) return {};
    if (typeof query.getFilter === 'function') return query.getFilter();
    if (typeof query.getQuery === 'function') return query.getQuery();
    return {};
  };

  const getQueryModel = (query) => {
    if (query?.model) return query.model;
    if (Model) return Model;
    return null;
  };

  async function forEachQueryDoc(query, multiple, hookName, iterator) {
    const QueryModel = getQueryModel(query);
    if (!QueryModel) return;
    const filter = getQueryFilter(query);
    if (multiple) {
      const cursor = QueryModel.find(filter).cursor();
      for await (const doc of cursor) {
        await iterator(doc, hookName);
      }
    } else {
      const doc = await QueryModel.findOne(filter);
      if (doc) await iterator(doc, hookName);
    }
  }

  async function stashDocsForCleanup(query, multiple, hookName) {
    try {
      const QueryModel = getQueryModel(query);
      if (!QueryModel) {
        query.__kgDocsForCleanup = [];
        return;
      }
      const filter = getQueryFilter(query);
      if (multiple) {
        query.__kgDocsForCleanup = await QueryModel.find(filter);
      } else {
        const doc = await QueryModel.findOne(filter);
        query.__kgDocsForCleanup = doc ? [doc] : [];
      }
    } catch (err) {
      reportHookError(err, hookName);
      query.__kgDocsForCleanup = [];
    }
  }

  async function processStashedDocs(query, hookName) {
    const docs = query.__kgDocsForCleanup;
    delete query.__kgDocsForCleanup;
    if (!Array.isArray(docs) || docs.length === 0) return;
    for (const doc of docs) {
      await cleanupDoc(doc, hookName);
    }
  }

  schema.post('save', function(doc) {
    return syncDoc(doc, 'post:save');
  });

  schema.post('insertMany', function(docs) {
    const created = Array.isArray(docs) ? docs : [docs];
    return created.reduce(
      (p, doc) => p.then(() => syncDoc(doc, 'post:insertMany')),
      Promise.resolve()
    );
  });

  schema.post('remove', function(doc) {
    return cleanupDoc(doc, 'post:remove');
  });

  schema.post('deleteOne', { document: true, query: false }, function(doc) {
    return cleanupDoc(doc, 'post:deleteOne(document)');
  });

  const findUpdateHooks = [
    'findOneAndUpdate',
    'findOneAndReplace',
    'findByIdAndUpdate'
  ];

  findUpdateHooks.forEach((hook) => {
    schema.post(hook, function(doc) {
      return syncDoc(doc, `post:${hook}`);
    });
  });

  const queryUpdateHooks = [
    { name: 'updateOne', multiple: false },
    { name: 'replaceOne', multiple: false },
    { name: 'updateMany', multiple: true }
  ];

  queryUpdateHooks.forEach(({ name, multiple }) => {
    schema.post(name, { document: false, query: true }, function() {
      return forEachQueryDoc(this, multiple, `post:${name}`, syncDoc);
    });
  });

  const findDeleteHooks = [
    'findOneAndDelete',
    'findOneAndRemove',
    'findByIdAndDelete',
    'findByIdAndRemove'
  ];

  findDeleteHooks.forEach((hook) => {
    schema.post(hook, function(doc) {
      return cleanupDoc(doc, `post:${hook}`);
    });
  });

  schema.pre('deleteOne', { document: false, query: true }, function() {
    return stashDocsForCleanup(this, false, 'pre:deleteOne(query)');
  });
  schema.post('deleteOne', { document: false, query: true }, function() {
    return processStashedDocs(this, 'post:deleteOne(query)');
  });

  schema.pre('deleteMany', { document: false, query: true }, function() {
    return stashDocsForCleanup(this, true, 'pre:deleteMany');
  });
  schema.post('deleteMany', { document: false, query: true }, function() {
    return processStashedDocs(this, 'post:deleteMany');
  });


  // === GRAPH HELPERS ===============================================
  function _asStr(x) {
    return (x && typeof x === 'object' && x.toString) ? x.toString() : String(x);
  }

  // Unweighted shortest path (BFS over levels, 1 batched query per level)
  async function _bfsShortestPath({ aId, bId, directed = false, maxDepth = 20, edgesModel }) {
    if (!edgesModel) throw new Error('kgInit() must be called: edgesModel missing');

    const start = _asStr(aId);
    const goal  = _asStr(bId);
    if (start === goal) return { distance: 0, path: [start] };

    const visited = new Set([start]);
    const parent  = new Map();
    let frontier  = [start];

    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      // Pull all edges incident to current frontier in one go
      const qry = directed
        ? { source: { $in: frontier } }
        : { $or: [{ source: { $in: frontier } }, { target: { $in: frontier } }] };

      const edges = await edgesModel
      .find(qry, 'source target') 
      .lean();

      // Build adjacency for this layer
      const adj = new Map(); // nodeStr -> neighborStr[]
      for (const e of edges) {
        const s = _asStr(e.source);
        const t = _asStr(e.target);
        if (directed) {
          if (!adj.has(s)) adj.set(s, []);
          adj.get(s).push(t);
        } else {
          if (!adj.has(s)) adj.set(s, []);
          if (!adj.has(t)) adj.set(t, []);
          adj.get(s).push(t);
          adj.get(t).push(s);
        }
      }

      const next = [];
      for (const u of frontier) {
        const nbrs = adj.get(u) || [];
        for (const v of nbrs) {
          if (visited.has(v)) continue;
          visited.add(v);
          parent.set(v, u);
          if (v === goal) {
            // Reconstruct
            const path = [v];
            while (path[path.length - 1] !== start) {
              path.push(parent.get(path[path.length - 1]));
            }
            path.reverse();
            return { distance: path.length - 1, path };
          }
          next.push(v);
        }
      }
      frontier = next;
    }

    return { distance: Infinity, path: [] };
  }

  // Weighted shortest path (Dijkstra with batched per-node edge fetch)
  async function _dijkstraWeightedPath({
    aId,
    bId,
    directed = true,
    weightField = 'weight',
    defaultWeight = 1,
    maxVisits = 1e6,
    edgesModel
  }) {
    if (!edgesModel) throw new Error('kgInit() must be called: edgesModel missing');

    const start = _asStr(aId);
    const goal  = _asStr(bId);
    if (start === goal) return { distance: 0, path: [start] };

    // Tiny PQ (binary heap)
    class PQ {
      constructor() { this.h = []; }
      push(x) { this.h.push(x); this._up(this.h.length - 1); }
      pop() {
        if (!this.h.length) return null;
        const top = this.h[0];
        const last = this.h.pop();
        if (this.h.length) { this.h[0] = last; this._down(0); }
        return top;
      }
      _up(i){ for(; i>0; ){ const p=(i-1)>>1; if (this.h[p].d <= this.h[i].d) break; [this.h[p],this.h[i]]=[this.h[i],this.h[p]]; i=p; } }
      _down(i){ for(;;){ let l=i*2+1,r=l+1,m=i; if(l<this.h.length && this.h[l].d<this.h[m].d) m=l; if(r<this.h.length && this.h[r].d<this.h[m].d) m=r; if(m===i) break; [this.h[m],this.h[i]]=[this.h[i],this.h[m]]; i=m; } }
      get length(){ return this.h.length; }
    }

    const dist   = new Map([[start, 0]]);
    const parent = new Map();
    const seen   = new Set();
    const pq     = new PQ();
    pq.push({ id: start, d: 0 });

    let steps = 0;

    while (pq.length) {
      const { id: u, d } = pq.pop();
      if (seen.has(u)) continue;
      seen.add(u);

      if (++steps > maxVisits) break;
      if (u === goal) break;

      // Only edges *from* u in directed graphs; all incident edges if undirected
      const qry = directed ? { source: u } : { $or: [{ source: u }, { target: u }] };
      const edges = await edgesModel
      .find(qry, `source target ${weightField}`)
      .lean();

      for (const e of edges) {
        const v = directed ? _asStr(e.target) : (e.source === u ? _asStr(e.target) : _asStr(e.source));
        const w = (typeof e[weightField] === 'number') ? e[weightField] : defaultWeight;
        const alt = d + (w >= 0 ? w : defaultWeight); // guard negatives

        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          parent.set(v, u);
          pq.push({ id: v, d: alt });
        }
      }
    }

    if (!dist.has(goal)) return { distance: Infinity, path: [] };

    // Reconstruct
    const path = [goal];
    while (path[path.length - 1] !== start) {
      path.push(parent.get(path[path.length - 1]));
    }
    path.reverse();
    return { distance: dist.get(goal), path };
  }

  // === Generic recommendation helper =========================================
    /**
     * 2-hop recommender with per-hop fanout caps.
     *
     * @param {string} startId
     * @param {object} opts
     *   - mode: 'unweighted' | 'weighted' (default 'unweighted')
     *   - limit: number (default 5)
     *   - includePath: boolean (default false; returns [start, via, cand] in weighted mode)
     *   - relationship: string | string[] (optional)
     *   - direction: 'out' | 'in' | 'any' (default 'any')
     *   - targetType: string | string[] (optional)
     *   - targetFilter: object (optional; filters on node fields)
     *   - weightField: string (default 'weight')   // weighted
     *   - defaultWeight: number (default 1)        // weighted
     *   - fanout: number (default 64)              // cap per node per hop
     */
    if (!schema.statics.kgRecommend) {
      schema.statics.kgRecommend = async function (
        startId,
        {
          mode = 'unweighted',
          limit = 5,
          includePath = false,
          relationship,
          direction = 'any',
          targetType,
          targetFilter,

          // weighted opts
          weightField = 'weight',
          defaultWeight = 1,

          // traversal cap
          fanout = 64,
        } = {}
      ) {
        const { edgesModel, nodesModel } = getCtx();
        if (!edgesModel || !nodesModel) throw new Error('kgInit() must be called');

        const start = String(startId);
        const rels = Array.isArray(relationship)
          ? relationship
          : (relationship ? [relationship] : []);

        // ------------------------------------------------------------
        // Weighted 2-hop, robust across 'out' | 'in' | 'any'
        // - Normalizes direction via $cond instead of $facet.
        // - Returns score, w1, w2, distance, and optional path.
        // ------------------------------------------------------------
        async function weighted2Hop() {
          const E = edgesModel.collection.name;
          const N = nodesModel.collection.name;
          const relMatch = rels.length ? { relationship: { $in: rels } } : {};

          // Helper to build hop1 and hop2 for each direction mode
          const buildPipelines = (dir) => {
            // Hop-1: pick neighbors of start and compute w1.
            // For 'any', we match edges where source==start OR target==start,
            // then normalize 'via' with a $cond.
            const hop1Match =
              dir === 'out'
                ? { $match: { source: start, ...relMatch } }
                : dir === 'in'
                ? { $match: { target: start, ...relMatch } }
                : { $match: { $or: [{ source: start }, { target: start }], ...relMatch } };

            const hop1Via =
              dir === 'out'
                ? { $project: { _id: 0, via: '$target', w1: { $ifNull: [`$${weightField}`, defaultWeight] } } }
                : dir === 'in'
                ? { $project: { _id: 0, via: '$source', w1: { $ifNull: [`$${weightField}`, defaultWeight] } } }
                : {
                    $project: {
                      _id: 0,
                      via: {
                        $cond: [{ $eq: ['$source', start] }, '$target', '$source']
                      },
                      w1: { $ifNull: [`$${weightField}`, defaultWeight] }
                    }
                  };

            const hop1Sort = { $sort: { w1: -1 } };
            const hop1Limit = { $limit: fanout };

            // Hop-2: from via -> candidates, normalize cand + w2 by direction
            const hop2MatchExpr =
              dir === 'out'
                ? { $expr: { $eq: ['$source', '$$via'] } }
                : dir === 'in'
                ? { $expr: { $eq: ['$target', '$$via'] } }
                : {
                    $expr: {
                      $or: [
                        { $eq: ['$source', '$$via'] },
                        { $eq: ['$target', '$$via'] }
                      ]
                    }
                  };

            const hop2CandProject =
              dir === 'out'
                ? { cand: '$target', w2: { $ifNull: [`$${weightField}`, defaultWeight] }, _id: 0 }
                : dir === 'in'
                ? { cand: '$source', w2: { $ifNull: [`$${weightField}`, defaultWeight] }, _id: 0 }
                : {
                    _id: 0,
                    cand: {
                      $cond: [{ $eq: ['$source', '$$via'] }, '$target', '$source']
                    },
                    w2: { $ifNull: [`$${weightField}`, defaultWeight] }
                  };

            const hop2Lookup = [
              {
                $lookup: {
                  from: E,
                  let: { via: '$via' },
                  pipeline: [
                    { $match: hop2MatchExpr },
                    ...(rels.length ? [{ $match: relMatch }] : []),
                    { $project: hop2CandProject },
                    { $sort: { w2: -1 } },
                    { $limit: fanout }
                  ],
                  as: 'two'
                }
              },
              { $unwind: '$two' },
              {
                $project: {
                  _id: 0,
                  cand: '$two.cand',
                  via: '$via',
                  w1: '$w1',
                  w2: '$two.w2',
                  score: { $add: ['$w1', '$two.w2'] }
                }
              }
            ];

            return [hop1Match, hop1Via, hop1Sort, hop1Limit, ...hop2Lookup];
          };

          // Build base pipeline for the selected direction
          let base = buildPipelines(direction);

          const pipeline = [
            ...base,
            { $match: { cand: { $ne: start } } },
            { $sort: { score: -1 } },
            {
              // keep BEST path per candidate
              $group: {
                _id: '$cand',
                score: { $first: '$score' },
                via: { $first: '$via' },
                w1: { $first: '$w1' },
                w2: { $first: '$w2' }
              }
            },
            { $sort: { score: -1 } },
          ];

          // Optional node filtering
          if (targetType || targetFilter) {
            pipeline.push(
              {
                $lookup: {
                  from: N,
                  localField: '_id',
                  foreignField: 'id',
                  pipeline: [{ $project: { _id: 0, id: 1, type: 1, properties: 1, label: 1 } }],
                  as: 'node'
                }
              },
              { $unwind: '$node' },
            );
            if (targetType) {
              pipeline.push({
                $match: { 'node.type': Array.isArray(targetType) ? { $in: targetType } : targetType }
              });
            }
            if (targetFilter && typeof targetFilter === 'object') {
              const tf = {};
              for (const [k, v] of Object.entries(targetFilter)) tf[`node.${k}`] = v;
              pipeline.push({ $match: tf });
            }
          }

          pipeline.push(
            { $limit: Math.max(1, limit) },
            { $project: { _id: 0, id: '$_id', score: 1, via: 1, w1: 1, w2: 1 } }
          );

          const rows = await edgesModel.aggregate(pipeline).allowDiskUse(true).exec();
          if (!rows.length) return [];

          // hydrate once
          const ids = rows.map(r => r.id);
          const docs = await nodesModel.find(
            { id: { $in: ids } },
            { id: 1, label: 1, type: 1, properties: 1, _id: 0 }
          ).lean();

          const byId = new Map(docs.map(d => [d.id, d]));
          const titleOf = (d) =>
            d?.properties?.title ?? d?.properties?.name ?? d?.label ?? d?.id;

          return rows.map(r => {
            const d = byId.get(r.id);
            const out = {
              id: r.id,
              type: d?.type,
              title: titleOf(d),
              score: r.score,      // w1 + w2 actually used
              w1: r.w1,
              w2: r.w2,
              distance: 2
            };
            if (includePath && r.via) out.path = [start, r.via, r.id];
            return out;
          });
        }

        // ------------------------------------------------------------
        // Unweighted 2-hop with capped fanout (fast, predictable)
        // ------------------------------------------------------------
        async function unweighted2HopCapped() {
          const relFilter = rels.length ? { relationship: { $in: rels } } : {};

          async function topK(frontier, dir, k) {
            if (!frontier?.length) return [];
            if (dir === 'out') {
              const docs = await edgesModel.aggregate([
                { $match: { source: { $in: frontier }, ...relFilter } },
                { $group: { _id: '$source', nbrs: { $push: '$target' } } },
                { $project: { _id: 0, nbrs: { $slice: ['$nbrs', k] } } },
              ]).allowDiskUse(true);
              return docs.flatMap(d => d.nbrs);
            }
            if (dir === 'in') {
              const docs = await edgesModel.aggregate([
                { $match: { target: { $in: frontier }, ...relFilter } },
                { $group: { _id: '$target', nbrs: { $push: '$source' } } },
                { $project: { _id: 0, nbrs: { $slice: ['$nbrs', k] } } },
              ]).allowDiskUse(true);
              return docs.flatMap(d => d.nbrs);
            }
            const [o, i] = await Promise.all([
              topK(frontier, 'out', Math.ceil(k / 2)),
              topK(frontier, 'in',  Math.floor(k / 2)),
            ]);
            return [...new Set([...o, ...i])];
          }

          let frontier = [start];
          frontier = await topK(frontier, direction, fanout); // hop 1
          if (!frontier.length) return [];
          frontier = await topK(frontier, direction, fanout); // hop 2
          if (!frontier.length) return [];

          const cand = [...new Set(frontier.filter(id => id !== start))];
          if (!cand.length) return [];

          // optional node filtering
          let candIds = cand;
          if (targetType || targetFilter) {
            const nodeQuery = { id: { $in: candIds } };
            if (targetType) nodeQuery.type = Array.isArray(targetType) ? { $in: targetType } : targetType;
            if (targetFilter && typeof targetFilter === 'object') Object.assign(nodeQuery, targetFilter);
            const found = await nodesModel.find(nodeQuery, { id: 1 }).lean();
            const ok = new Set(found.map(d => d.id));
            candIds = candIds.filter(id => ok.has(id));
          }
          if (!candIds.length) return [];

          // hydrate + present
          const docs = await nodesModel.find(
            { id: { $in: candIds } },
            { id: 1, label: 1, type: 1, properties: 1, _id: 0 }
          ).lean();
          const byId = new Map(docs.map(d => [d.id, d]));
          const titleOf = (d) =>
            d?.properties?.title ?? d?.properties?.name ?? d?.label ?? d?.id;

          return candIds.slice(0, Math.max(1, limit)).map(id => {
            const d = byId.get(id);
            return { id, type: d?.type, title: titleOf(d), distance: 2 };
          });
        }

        // ===== dispatch =====
        if (mode === 'weighted') {
          const rows = await weighted2Hop();
          if (!rows.length) return await unweighted2HopCapped(); // graceful fallback
          return rows;
        } else {
          return await unweighted2HopCapped();
        }
      };
    }



  if (Model && !Model.kgRecommend) {
    Model.kgRecommend = schema.statics.kgRecommend;
  }
  // ======================== END OF GRAPH HELPERS ===================================================



  return modelOrSchema;
}

module.exports = { bindModel };
