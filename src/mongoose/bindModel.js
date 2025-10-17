const { kgBulkSync } = require('../core/bulkSync');
const { getCtx } = require('../core/init');

function bindModel(model, config) {
  if (!config || typeof config.node !== 'function') {
    throw new Error('bindModel() requires a config with a node(doc) function');
  }
  const { node: buildNode, edges: buildEdges, cleanup: buildCleanup } = config;

  async function sync(doc) {
    const node = buildNode(doc);
    const edges = buildEdges ? await buildEdges(doc, getCtx()) : [];
    // NOTE: org_id is optional; kgBulkSync will ignore if unsupported
    await kgBulkSync({ desiredNodes: [node], desiredEdges: edges });
  }

  async function performCleanup(doc) {
    const node = buildNode(doc);
    const filters = buildCleanup ? buildCleanup(doc) : [{ source: node.id }, { id: node.id }];
    const { nodesModel, edgesModel } = getCtx();
    await edgesModel.deleteMany({ $or: filters });
    await nodesModel.deleteOne({ id: node.id });
  }

  // ----- Save/update/delete paths (cover .save(), findOneAndUpdate, findOneAndDelete, doc.deleteOne) -----
  model.post('save', async function(doc) {
    try { await sync(doc); } catch (err) { console.error('[bindModel post:save]', err); }
  });

  model.post('findOneAndUpdate', async function(doc) {
    try { if (doc) await sync(doc); } catch (err) { console.error('[bindModel post:findOneAndUpdate]', err); }
  });

  model.post('findOneAndDelete', async function(doc) {
    try { if (doc) await performCleanup(doc); } catch (err) { console.error('[bindModel post:findOneAndDelete]', err); }
  });

  model.post('deleteOne', { document: true, query: false }, async function(doc) {
    try { if (doc) await performCleanup(doc); } catch (err) { console.error('[bindModel post:deleteOne]', err); }
  });

  model.post('insertMany', async function(docs) {
    try {
      if (!Array.isArray(docs)) return;
      // run sync for each inserted doc
      for (const doc of docs) {
        try { await sync(doc); } catch (err) { console.error('[bindModel post:insertMany item]', err); }
      }
    } catch (err) {
      console.error('[bindModel post:insertMany]', err);
    }
  });
}

module.exports = { bindModel };
