const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

/**
 * @param {mongoose.Model|mongoose.Schema} modelOrSchema
 * @param {Object} config
 */
function bindModel(modelOrSchema, config) {
  if (!config || typeof config.node !== 'function') {
    throw new Error('bindModel() requires a config with a node(doc) function');
  }

  // Accept either a compiled Model or a Schema
  const schema = (typeof modelOrSchema?.post === 'function' && !modelOrSchema.base)
    ? modelOrSchema                     // it's a Schema (has .post and no .base)
    : modelOrSchema?.schema;            // it's a Model -> use its schema

  if (!schema || typeof schema.post !== 'function') {
    throw new Error('bindModel(): pass a Mongoose Model or Schema');
  }

  const { node: buildNode, edges: buildEdges, cleanup: buildCleanup } = config;

  async function sync(doc) {
    const node = buildNode(doc);
    const edges = buildEdges ? await buildEdges(doc, getCtx()) : [];
    await kgBulkSync({
      desiredNodes: [node],
      desiredEdges: edges,
      keepExtra: { edges: true }  // safe default, no pruning
    });
  }

  async function performCleanup(doc) {
    const node = buildNode(doc);
    const filters = buildCleanup ? buildCleanup(doc) : [{ source: node.id }, { id: node.id }];
    const { nodesModel, edgesModel } = getCtx();
    await edgesModel.deleteMany({ $or: filters });
    await nodesModel.deleteOne({ id: node.id });
  }

  // Attach hooks on the SCHEMA
  schema.post('save', async function(doc) {
    try { await sync(doc); } catch (_) {}
  });

  schema.post('findOneAndUpdate', async function(doc) {
    try { if (doc) await sync(doc); } catch (_) {}
  });

  schema.post('findOneAndDelete', async function(doc) {
    try { if (doc) await performCleanup(doc); } catch (_) {}
  });

  schema.post('deleteOne', { document: true, query: false }, async function(doc) {
    try { if (doc) await performCleanup(doc); } catch (_) {}
  });
}

module.exports = { bindModel };
