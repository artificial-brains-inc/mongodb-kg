const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

/**
 * Attach graph synchronisation logic to a Mongoose model.  You
 * provide mapping functions that describe how a document becomes a
 * single canonical node and which edges it should spawn.
 *
 * @param {mongoose.Model} model - The model to bind
 * @param {Object} config - Configuration object
 * @param {Function} config.node - Function that returns the node record
 * @param {Function} [config.edges] - Function that returns an array of edge records; may be async
 * @param {Function} [config.cleanup] - Function that returns an array of filters for deletion
 */
function bindModel(model, config) {
  if (!config || typeof config.node !== 'function') {
    throw new Error('bindModel() requires a config with a node(doc) function');
  }

  const { node: buildNode, edges: buildEdges, cleanup: buildCleanup } = config;

  // When a document is saved or updated, compute the desired node
  // and edges and synchronise them with the graph.
  async function sync(doc) {
    const node = buildNode(doc);
    const edges = buildEdges ? await buildEdges(doc, getCtx()) : [];
    await kgBulkSync({
      desiredNodes: [node],
      desiredEdges: edges,
      org_id: node.org_id
    });
  }

  // When a document is deleted, clean up the node and its edges.
  async function performCleanup(doc) {
    const node = buildNode(doc);
    const filters = buildCleanup ? buildCleanup(doc) : [{ source: node.id }, { id: node.id }];
    const { nodesModel, edgesModel } = getCtx();
    // Remove edges matching any of the filters
    await edgesModel.deleteMany({ $or: filters });
    // Remove the node
    await nodesModel.deleteOne({ id: node.id });
  }

  model.post('save', async function(doc) {
    await sync(doc);
  });

  model.post('findOneAndUpdate', async function(doc) {
    if (doc) await sync(doc);
  });

  model.post('findOneAndDelete', async function(doc) {
    if (doc) await performCleanup(doc);
  });

  model.post('deleteOne', { document: true, query: false }, async function(doc) {
    if (doc) await performCleanup(doc);
  });
}

module.exports = {
  bindModel
};