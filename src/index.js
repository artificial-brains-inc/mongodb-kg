// Central export for the MongoDB_artificialbrains_KG SDK.
// This file re-exports the core primitives, Mongoose bindings
// and helper definitions.  Most consumers will only need to import
// from this module.

const { kgInit, getCtx } = require('./core/init');
const { createNode, createEdge, deleteEdges } = require('./core/crud');
const { kgBulkSync } = require('./core/bulkSync');
const { bindModel } = require('./mongoose/bindModel');
const { defineEntityType } = require('./dsl/defineEntityType');
const { createGraphModels } = require('./mongoose/createModels');

// Common enumerations for node types and relationships.  Use these
// values or define your own strings – the SDK does not enforce
// anything beyond uniqueness.
const NodeType = {
  Person: 'person',
  Team: 'team',
  Organization: 'organization',
  Memory: 'memory',
  Group: 'group',
  Assessment: 'assessment',
  Courses: 'courses',
  MemEmbedding: 'mem_embedding'
};

const Relationship = {
  Manages: 'manages',
  MemberOf: 'member_of',
  WorksWith: 'works_with',
  WorksAt: 'works_at',
  ReportsTo: 'reports_to',
  Leads: 'leads',
  WorksOn: 'works_on',
  Initiated: 'initiated',
  Completed: 'completed',
  MemoryOf: 'memory_of',
  SingleMemOf: 'single_mem_of',
  BelongsTo: 'belongs_to',
  OwnedBy: 'owned_by',
  Member: 'member'
};

module.exports = {
  kgInit,
  getCtx,
  createNode,
  createEdge,
  deleteEdges,
  kgBulkSync,
  bindModel,
  defineEntityType,
  createGraphModels,
  NodeType,
  Relationship
};