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
     * Generic recommender over the graph.
     *
     * @param {string} startId - id of the starting node (e.g., 'movie_...', 'user_...')
     * @param {object} opts
     *   - mode: 'unweighted' | 'weighted' (default 'unweighted')
     *   - limit: number (default 5)
     *   - includePath: boolean (default false)
     *   - // Simple expansion mode (ignore metaPath if provided):
     *   - hops: number of edge traversals (default 2)
     *   - relationship: string | string[] (edge relationship(s) to use) (optional)
     *   - direction: 'out' | 'in' | 'any' (default 'any')
     *   - targetType: string | string[] (optional node type filter)
     *   - targetFilter: Mongo-ish filter applied to nodesModel (optional)
     *   - // Weighted options:
     *   - weightField: string (default 'weight')
     *   - defaultWeight: number (default 1)
     *   - // Advanced: explicit meta-path pattern overrides the simple expansion
     *   - metaPath: Array<{ relationship?: string|string[], direction?: 'out'|'in'|'any', nodeType?: string|string[] }>
     *   - fanout at 64 nodes per step is default
     */
    if (!schema.statics.kgRecommend) {
      schema.statics.kgRecommend = async function (
        startId,
        {
          mode = 'unweighted',
          limit = 5,
          includePath = false,

          // Simple expansion defaults
          hops = 2,
          relationship,
          direction = 'any',
          targetType,
          targetFilter,

          // Weighted
          weightField = 'weight',
          defaultWeight = 1,

          // Advanced meta-path
          metaPath,

          // cap branching factor per node per hop
          fanout = 64,
        } = {}
      ) {
        const { edgesModel, nodesModel } = getCtx();
        if (!edgesModel || !nodesModel) throw new Error('kgInit() must be called');

        const toArray = (x) => (Array.isArray(x) ? x : x != null ? [x] : null);
        const rels = toArray(relationship);

        // ---------- FAST PATH: weighted, <=2 hops, no metaPath ----------
        async function fastWeighted2Hop({
          startId, relationship, direction = 'any',
          fanout = 64, limit = 5, weightField = 'weight',
          targetType, includePath = false, nodesModel, edgesModel
        }) {
          const E = edgesModel.collection.name;
          const N = nodesModel.collection.name;
          const rels = Array.isArray(relationship) ? relationship : (relationship ? [relationship] : []);
          const relMatchStage = rels.length ? [{ $match: { relationship: { $in: rels } } }] : [];

          // hop1: rank & cap
          const hop1Out = [
            { $match: { source: String(startId) } },
            ...relMatchStage,
            { $sort: { [weightField]: -1, source: 1 } },
            { $limit: fanout },
            { $project: { via: '$target', w1: `$${weightField}`, _id: 0 } }
          ];
          const hop1In = [
            { $match: { target: String(startId) } },
            ...relMatchStage,
            { $sort: { [weightField]: -1, target: 1 } },
            { $limit: fanout },
            { $project: { via: '$source', w1: `$${weightField}`, _id: 0 } }
          ];

          // hop2: from via → candidates, rank & cap
          const hop2 = (dir) => ([
            {
              $lookup: {
                from: E,
                let: { via: '$via' },
                pipeline: [
                  { $match: { $expr: { $eq: [dir === 'out' ? '$source' : '$target', '$$via'] } } },
                  ...relMatchStage,
                  { $sort: { [weightField]: -1 } },
                  { $limit: fanout },
                  { $project: { cand: dir === 'out' ? '$target' : '$source', w2: `$${weightField}`, _id: 0 } }
                ],
                as: 'two'
              }
            },
            { $unwind: '$two' },
            { $project: { cand: '$two.cand', via: '$via', score: { $add: ['$w1', '$two.w2'] }, _id: 0 } }
          ]);

          // out / in / any
          let base;
          if (direction === 'out') base = [...hop1Out, ...hop2('out')];
          else if (direction === 'in') base = [...hop1In, ...hop2('in')];
          else {
            base = [
              { $facet: { OUT: [...hop1Out, ...hop2('out')], IN: [...hop1In, ...hop2('in')] } },
              { $project: { all: { $setUnion: ['$OUT', '$IN'] } } },
              { $unwind: '$all' },
              { $replaceRoot: { newRoot: '$all' } }
            ];
          }

          const pipeline = [
            ...base,
            { $match: { cand: { $ne: String(startId) } } },
            { $group: { _id: '$cand', score: { $sum: '$score' }, via: { $first: '$via' } } },
            { $sort: { score: -1 } }
          ];

          // optional type filter
          if (targetType) {
            pipeline.push(
              {
                $lookup: {
                  from: N,
                  localField: '_id',
                  foreignField: 'id',
                  pipeline: [{ $project: { id: 1, type: 1, properties: 1, _id: 0 } }],
                  as: 'node'
                }
              },
              { $unwind: '$node' },
              { $match: { 'node.type': Array.isArray(targetType) ? { $in: targetType } : targetType } }
            );
          }

          pipeline.push(
            { $limit: Math.max(1, limit) },
            { $project: { id: '$_id', score: 1, via: 1, _id: 0 } }
          );

          const rows = await edgesModel.aggregate(pipeline, { allowDiskUse: true }).toArray();
          if (!rows.length) return [];

          // hydrate once
          const ids = rows.map(r => r.id);
          const docs = await nodesModel.find(
            { id: { $in: ids } },
            { id: 1, label: 1, type: 1, properties: 1, _id: 0 }
          ).lean();

          const byId = new Map(docs.map(d => [d.id, d]));
          const titleOf = (d) => d?.properties?.title ?? d?.properties?.name ?? d?.label ?? d?.id;

          return rows.map(r => {
            const d = byId.get(r.id);
            const out = { id: r.id, type: d?.type, title: titleOf(d), score: r.score };
            if (includePath && r.via) out.path = [String(startId), r.via, r.id];
            return out;
          });
        }

        const canFastPath =
          mode === 'weighted' &&
          !metaPath &&
          (hops == null || hops <= 2);

        if (canFastPath) {
          return await fastWeighted2Hop({
            startId,
            relationship: rels,
            direction,
            fanout,
            limit,
            weightField,
            targetType,
            includePath,
            nodesModel,
            edgesModel
          });
        }

        // ---------- FALLBACK (your original logic, with fanout capping) ----------
        // ---- helper: top-K neighbors per node using aggregation
        async function topKNeighbors({ frontier, dir, rels, k, weightField }) {
          if (!frontier?.length) return [];

          const relFilter = rels ? { relationship: { $in: rels } } : {};

          if (dir === 'out') {
            const docs = await edgesModel.aggregate([
              { $match: { source: { $in: frontier }, ...relFilter } },
              { $sort: { [weightField]: -1, source: 1 } },
              { $group: { _id: '$source', nbrs: { $push: '$target' } } },
              { $project: { _id: 0, nbrs: { $slice: ['$nbrs', k] } } },
            ]).allowDiskUse(true);
            return docs.flatMap(d => d.nbrs);
          }

          if (dir === 'in') {
            const docs = await edgesModel.aggregate([
              { $match: { target: { $in: frontier }, ...relFilter } },
              { $sort: { [weightField]: -1, target: 1 } },
              { $group: { _id: '$target', nbrs: { $push: '$source' } } },
              { $project: { _id: 0, nbrs: { $slice: ['$nbrs', k] } } },
            ]).allowDiskUse(true);
            return docs.flatMap(d => d.nbrs);
          }

          // 'any' → combine capped OUT and IN
          const [outNbrs, inNbrs] = await Promise.all([
            topKNeighbors({ frontier, dir: 'out', rels, k: Math.ceil(k / 2), weightField }),
            topKNeighbors({ frontier, dir: 'in',  rels, k: Math.floor(k / 2), weightField }),
          ]);
          return [...new Set([...outNbrs, ...inNbrs])];
        }

        async function expand(frontier) {
          return topKNeighbors({ frontier, dir: direction, rels, k: fanout, weightField });
        }

        async function expandMeta(frontier, step) {
          const relsStep = toArray(step.relationship);
          const dir = step.direction || 'any';
          const k = Number.isFinite(step.fanout) ? step.fanout : fanout;
          return topKNeighbors({ frontier, dir, rels: relsStep, k, weightField });
        }

        // --- 1) Build candidate set via simple hops or metaPath ---
        let frontier = [startId];
        let candidates = new Set();

        if (Array.isArray(metaPath) && metaPath.length > 0) {
          for (let i = 0; i < metaPath.length; i++) {
            frontier = await expandMeta(frontier, metaPath[i]);
            if (!frontier.length) break;
            if (frontier.length > fanout * 8) frontier = frontier.slice(0, fanout * 8);
          }
          candidates = new Set(frontier);
        } else {
          for (let i = 0; i < Math.max(1, hops); i++) {
            frontier = await expand(frontier);
            if (!frontier.length) break;
            if (frontier.length > fanout * 8) frontier = frontier.slice(0, fanout * 8);
          }
          candidates = new Set(frontier);
        }

        candidates.delete(String(startId));

        // Optional: constrain to targetType / targetFilter
        let candIds = [...candidates];
        if (targetType || targetFilter) {
          const typeArr = toArray(targetType);
          const nodeQuery = { id: { $in: candIds } };
          if (typeArr) nodeQuery.type = { $in: typeArr };
          if (targetFilter && typeof targetFilter === 'object') Object.assign(nodeQuery, targetFilter);
          const docs = await nodesModel.find(nodeQuery, { id: 1 }).lean();
          const ok = new Set(docs.map(d => d.id));
          candIds = candIds.filter(id => ok.has(id));
        }

        if (candIds.length === 0) return [];

        // --- 2) Score candidates (unchanged) ---
        const results = [];
        for (const cid of candIds) {
          let out;
          if (mode === 'weighted') {
            out = await this.kgWeightedPath(startId, cid, {
              directed: direction === 'out',
              weightField,
              defaultWeight
            });
          } else {
            out = await this.kgShortestPath(startId, cid, {
              directed: direction === 'out',
              maxDepth: Math.max(2, hops + 2)
            });
          }
          if (Number.isFinite(out?.distance)) {
            results.push({
              id: cid,
              distance: out.distance,
              score: mode === 'weighted' ? (1 / (1 + out.distance)) : undefined,
              path: includePath ? out.path : undefined
            });
          }
        }

        if (!results.length) return [];

        // --- 3) Sort and hydrate (unchanged) ---
        if (mode === 'weighted') {
          results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        } else {
          results.sort((a, b) => a.distance - b.distance);
        }
        const top = results.slice(0, Math.max(1, Math.min(50, limit)));
        const docs = await nodesModel.find(
          { id: { $in: top.map(t => t.id) } },
          { id: 1, label: 1, type: 1, properties: 1, _id: 0 }
        ).lean();

        const byId = new Map(docs.map(d => [d.id, d]));
        const titleOf = (d) => d?.properties?.title ?? d?.properties?.name ?? d?.label ?? d?.id;

        return top.map(t => {
          const d = byId.get(t.id);
          return {
            id: t.id,
            type: d?.type,
            title: titleOf(d),
            ...(mode === 'weighted' ? { score: t.score } : { distance: t.distance }),
            ...(includePath && t.path ? { path: t.path } : {})
          };
        });
      };
    }

  if (Model && !Model.kgRecommend) {
    Model.kgRecommend = schema.statics.kgRecommend;
  }
  // ======================== END OF GRAPH HELPERS ===================================================



  return modelOrSchema;
}

module.exports = { bindModel };
