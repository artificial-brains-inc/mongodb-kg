const { getCtx } = require('./init');

/**
 * Upsert a node into the nodes collection.  If a node with the same
 * id already exists it will be updated; otherwise a new document
 * will be created.
 *
 * @param {Object} node - A node record
 */
async function createNode(node) {
  const { nodesModel } = getCtx();
  if (!nodesModel) throw new Error('kgInit() must be called before createNode()');
  await nodesModel.findOneAndUpdate(
    { id: node.id },
    { $set: node },
    { upsert: true }
  );
}

/**
 * Upsert an edge into the edges collection.  If an edge with the same
 * id already exists it will be updated; otherwise a new document
 * will be created.
 *
 * @param {Object} edge - An edge record
 */
async function createEdge(edge) {
  const { edgesModel } = getCtx();
  if (!edgesModel) throw new Error('kgInit() must be called before createEdge()');
  await edgesModel.findOneAndUpdate(
    { id: edge.id },
    { $set: edge },
    { upsert: true }
  );
}

/**
 * Delete edges matching a filter.  Useful for ad hoc cleanup.  You
 * typically don’t need to call this directly when using bindModel().
 *
 * @param {Object} filter - MongoDB filter used with deleteMany()
 */
async function deleteEdges(filter) {
  const { edgesModel } = getCtx();
  if (!edgesModel) throw new Error('kgInit() must be called before deleteEdges()');
  await edgesModel.deleteMany(filter);
}

module.exports = {
  createNode,
  createEdge,
  deleteEdges
};