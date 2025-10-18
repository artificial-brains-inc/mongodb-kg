const mongoose = require('mongoose');

/**
 * Factory for creating node and edge models with sensible defaults.
 * You can specify additional fields for the `properties` object and
 * enumeration arrays for `type` and `relationship`.  The resulting
 * schemas include several indexes for common lookup patterns.
 *
 * @param {Object} opts
 * @param {Object} [opts.node] - Configuration for the node model
 * @param {string} [opts.node.name='GraphNode'] - Mongoose model name for nodes
 * @param {Object} [opts.node.extraProperties={}] - Additional schema definition for the `properties` field
 * @param {string[]} [opts.node.typeEnum=[]] - Allowed values for the `type` field; empty for any string
 * @param {Object} [opts.edge] - Configuration for the edge model
 * @param {string} [opts.edge.name='GraphEdge'] - Mongoose model name for edges
 * @param {Object} [opts.edge.extraProperties={}] - Additional schema definition for the `properties` field
 * @param {string[]} [opts.edge.relationshipEnum=[]] - Allowed values for the `relationship` field; empty for any string
 * @param {mongoose.Connection} [opts.connection] - Optional Mongoose connection; defaults to mongoose
 * @returns {{ NodeModel: mongoose.Model, EdgeModel: mongoose.Model }}
 */
function createGraphModels(opts = {}) {
  const nodeOpts = opts.node || {};
  const edgeOpts = opts.edge || {};
  const conn = opts.connection || mongoose;

  const typeEnum = Array.isArray(nodeOpts.typeEnum) && nodeOpts.typeEnum.length > 0 ? nodeOpts.typeEnum : undefined;
  const relationshipEnum = Array.isArray(edgeOpts.relationshipEnum) && edgeOpts.relationshipEnum.length > 0 ? edgeOpts.relationshipEnum : undefined;

  // Build the `properties` object for nodes.  Combine legacy `extraProperties`
  // and the new `customFields`.  Each custom field may specify an index.
  const nodeExtra = Object.assign({}, nodeOpts.extraProperties || {});
  const nodeCustom = nodeOpts.customFields || {};
  for (const [field, config] of Object.entries(nodeCustom)) {
    // Accept shorthand: if config is a type constructor, wrap it
    if (typeof config === 'function') {
      nodeExtra[field] = config;
    } else if (config && typeof config === 'object') {
      nodeExtra[field] = config.type;
    }
  }

  // Build the `properties` object for edges.  Combine legacy `extraProperties`
  // and the new `customFields`.
  const edgeExtra = Object.assign({}, edgeOpts.extraProperties || {});
  const edgeCustom = edgeOpts.customFields || {};
  for (const [field, config] of Object.entries(edgeCustom)) {
    if (typeof config === 'function') {
      edgeExtra[field] = config;
    } else if (config && typeof config === 'object') {
      edgeExtra[field] = config.type;
    }
  }

  const NodeSchema = new mongoose.Schema({
    id: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true, enum: typeEnum },
    source_collection: { type: String, required: true },
    source_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    properties: nodeExtra,
    metadata: {
      created_at: { type: Date, default: Date.now },
      updated_at: { type: Date, default: Date.now },
      last_synced: { type: Date, default: Date.now }
    }
  }, { timestamps: true });

  // Node indexes
  NodeSchema.index({ id: 1 }, { unique: true });
  NodeSchema.index({ type: 1 });
  NodeSchema.index({ type: 1, source_id: 1 });
  NodeSchema.index({ source_collection: 1, source_id: 1 });
  NodeSchema.index({ source_id: 1 });

  // Apply indexes for custom node fields
  for (const [field, config] of Object.entries(nodeCustom)) {
    if (config && typeof config === 'object' && config.index) {
      NodeSchema.index({ [`properties.${field}`]: 1 });
    }
  }

  const nodeName = nodeOpts.name || 'GraphNode';
  const NodeModel = conn.model(nodeName, NodeSchema);

  const EdgeSchema = new mongoose.Schema({
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    relationship: { type: String, required: true, enum: relationshipEnum },
    weight: { type: Number, default: 1.0 },
    properties: edgeExtra,
    metadata: {
      created_at: { type: Date, default: Date.now },
      updated_at: { type: Date, default: Date.now },
    }
  }, { timestamps: true });

  // Edge indexes
  EdgeSchema.index({ id: 1 }, { unique: true });
  EdgeSchema.index({ source: 1 });
  EdgeSchema.index({ target: 1 });
  EdgeSchema.index({ relationship: 1 });
  EdgeSchema.index({ source: 1, target: 1 });
  EdgeSchema.index({ source: 1, relationship: 1 });
  EdgeSchema.index({ target: 1, relationship: 1 });
  EdgeSchema.index({ source: 1, relationship: 1, weight: -1 });
  EdgeSchema.index({ target: 1, relationship: 1, weight: -1 });

  // Apply indexes for custom edge fields
  for (const [field, config] of Object.entries(edgeCustom)) {
    if (config && typeof config === 'object' && config.index) {
      EdgeSchema.index({ [`properties.${field}`]: 1 });
    }
  }

  const edgeName = edgeOpts.name || 'GraphEdge';
  const EdgeModel = conn.model(edgeName, EdgeSchema);

  return { NodeModel, EdgeModel };
}

module.exports = {
  createGraphModels
};