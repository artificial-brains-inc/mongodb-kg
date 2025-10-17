const { getCtx } = require('./init');

/**
 * Synchronise many nodes and edges at once.  This function will
 * upsert all provided nodes and edges.  By default it will also
 * remove any edges originating from a provided node that are not
 * present in the `desiredEdges` array.  This ensures that the
 * graph remains an accurate reflection of your document state.
 *
 * @param {Object} params
 * @param {Array<Object>} [params.desiredNodes] - Nodes to upsert
 * @param {Array<Object>} [params.desiredEdges] - Edges to upsert
 * @param {Object} [params.keepExtra] - Set to true to skip pruning
 */
async function kgBulkSync({ desiredNodes = [], desiredEdges = [], keepExtra = { nodes: false, edges: false } }) {
  const { nodesModel, edgesModel } = getCtx();
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit() must be called before kgBulkSync()');
  }

  // Build bulk operations for nodes
  const nodeOps = desiredNodes.map(node => ({
    updateOne: {
      filter: { id: node.id },
      update: { $set: node },
      upsert: true
    }
  }));

  // Build bulk operations for edges
  const edgeOps = desiredEdges.map(edge => ({
    updateOne: {
      filter: { id: edge.id },
      update: { $set: edge },
      upsert: true
    }
  }));

  // Determine which sources we control (one per node).  These are
  // used to identify edges that should be pruned.
  const controlledSources = new Set(desiredNodes.map(n => n.id));
  const desiredEdgeIds = new Set(desiredEdges.map(e => e.id));
  const pruneOps = [];

  if (!keepExtra.edges && controlledSources.size > 0) {
    pruneOps.push({
      deleteMany: {
        filter: {
          source: { $in: Array.from(controlledSources) },
          id: { $nin: Array.from(desiredEdgeIds) }
        }
      }
    });
  }

  // Execute bulk writes.  Only perform operations if there is something
  // to do; otherwise bulkWrite() complains about empty arrays.
  if (nodeOps.length) {
    await nodesModel.bulkWrite(nodeOps);
  }
  const edgeWrites = edgeOps.concat(pruneOps);
  if (edgeWrites.length) {
    await edgesModel.bulkWrite(edgeWrites);
  }
}

module.exports = {
  kgBulkSync
};