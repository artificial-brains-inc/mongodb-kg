const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

const BIND_FLAG = Symbol.for('kg:bindModel:bound');

function bindModel(modelOrSchema, config = {}) {
  if (!config || typeof config.node !== 'function') {
    throw new Error('bindModel() requires a config with a node(doc) function');
  }

  const schema = (typeof modelOrSchema?.post === 'function' && typeof modelOrSchema?.add === 'function' && !modelOrSchema.base)
    ? modelOrSchema
    : modelOrSchema?.schema;

  if (!schema || typeof schema.post !== 'function') {
    throw new Error('bindModel(): pass a Mongoose Model or Schema');
  }

  if (schema[BIND_FLAG]) {
    return modelOrSchema;
  }
  schema[BIND_FLAG] = true;

  const Model = typeof modelOrSchema?.find === 'function' ? modelOrSchema : null;
  const {
    node: buildNode,
    edges: buildEdges,
    cleanup: buildCleanup,
    keepExtra,
    onError
  } = config;

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
    const node = await Promise.resolve(buildNode(doc));
    if (!node || !node.id) {
      throw new Error('bindModel node(doc) must return an object with an id');
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
    if (buildCleanup) {
      const filters = await Promise.resolve(buildCleanup(doc, getCtx()));
      if (Array.isArray(filters) && filters.length > 0) {
        return filters;
      }
    }
    return [{ source: node.id }, { target: node.id }, { id: node.id }];
  }

  async function syncDoc(doc, hookName) {
    if (!doc) return;
    try {
      const node = await buildNodeSafe(doc);
      const edges = await buildEdgesSafe(doc);
      await kgBulkSync({
        desiredNodes: [node],
        desiredEdges: edges,
        keepExtra: defaultKeepExtra
      });
    } catch (err) {
      reportHookError(err, hookName);
    }
  }

  async function cleanupDoc(doc, hookName) {
    if (!doc) return;
    try {
      const node = await buildNodeSafe(doc);
      const filters = await buildCleanupFilters(doc, node);
      const { nodesModel, edgesModel } = getCtx();
      if (!nodesModel || !edgesModel) {
        throw new Error('kgInit() must be called before using bindModel()');
      }
      await edgesModel.deleteMany({ $or: filters });
      await nodesModel.deleteOne({ id: node.id });
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

  return modelOrSchema;
}

module.exports = { bindModel };
