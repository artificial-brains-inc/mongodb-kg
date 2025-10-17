const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

/**
 * Attach graph sync logic to a Mongoose Model or Schema.
 *
 * @param {mongoose.Model|mongoose.Schema} modelOrSchema
 * @param {Object} config
 * @param {(doc:any)=>Object} config.node
 * @param {(doc:any, ctx:{nodesModel:any,edgesModel:any,repos?:object})=>Promise<Object[]>|Object[]} [config.edges]
 * @param {(doc:any)=>Array<Object>} [config.cleanup]
 */
function bindModel(modelOrSchema, config) {
  if (!config || typeof config.node !== 'function') {
    throw new Error('bindModel() requires a config with a node(doc) function');
  }

  // Normalize: allow passing a Model or a Schema
  const schema = modelOrSchema && modelOrSchema.schema
    ? modelOrSchema.schema
    : modelOrSchema;

  if (!schema || typeof schema.post !== 'function') {
    throw new Error('bindModel(): pass a Mongoose Model or Schema');
  }

  const { node: buildNode, edges: buildEdges, cleanup: buildCleanup } = config;

  // Optional: add a harmless touch path once so strict schemas accept resync touches
  if (!schema.path('__kg_touch')) {
    schema.add({ __kg_touch: { type: Date, default: null } });
  }

  async function sync(doc) {
    const ctx = getCtx();
    if (!ctx.nodesModel || !ctx.edgesModel) {
      throw new Error('kgInit() must be called before bindModel() hooks run');
    }

    const node = buildNode(doc);
    const edges = buildEdges ? await buildEdges(doc, ctx) : [];

    // No org_id; keepExtra.edges=true means no pruning by default (safe)
    await kgBulkSync({
      desiredNodes: [node],
      desiredEdges: edges,
      keepExtra: { edges: true }
    });
  }

  async function performCleanup(doc) {
    const { nodesModel, edgesModel } = getCtx();
    if (!nodesModel || !edgesModel) {
      throw new Error('kgInit() must be called before bindModel() hooks run');
    }

    const node = buildNode(doc);
    const filters = buildCleanup
      ? buildCleanup(doc)
      : [{ source: node.id }, { id: node.id }];

    await edgesModel.deleteMany({ $or: filters });
    await nodesModel.deleteOne({ id: node.id });
  }

  // Attach hooks on the schema (works whether you passed Model or Schema)
  schema.post('save', async function (doc) {
    try { await sync(doc); } catch (err) { /* optional: console.error(err) */ }
  });

  schema.post('findOneAndUpdate', async function (doc) {
    try { if (doc) await sync(doc); } catch (err) { /* optional log */ }
  });

  schema.post('findOneAndDelete', async function (doc) {
    try { if (doc) await performCleanup(doc); } catch (err) { /* optional log */ }
  });

  // deleteOne(doc) path
  schema.post('deleteOne', { document: true, query: false }, async function (doc) {
    try { if (doc) await performCleanup(doc); } catch (err) { /* optional log */ }
  });
}

module.exports = { bindModel };
