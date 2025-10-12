# MongoDB_artificialbrains_KG

A generic knowledge‑graph SDK for [Mongoose](https://mongoosejs.com/) models.  It allows you to define how documents in any collection map to nodes in a graph and how those nodes relate to one another.  The SDK takes care of keeping the graph in sync as your data changes, wiring itself into your Mongoose models via middleware.

## Features

* **Schema‑agnostic** – works with any model.  You provide simple mapping functions to describe how a document becomes a graph node and which edges it spawns.
* **Idempotent** upserts – deterministic IDs ensure that repeated calls update existing nodes/edges instead of creating duplicates.
* **Automatic syncing** – attach the SDK to your models and it will update your graph on every create, update and delete.
* **Bulk operations** – efficiently upsert or prune large numbers of nodes and edges in a single call.
* **Minimal API** – only a handful of functions to learn: `kgInit`, `createNode`, `createEdge`, `bindModel`, `kgBulkSync`, and optional helpers like `defineEntityType`.

## Installation

Install the package alongside Mongoose.  The SDK lists `mongoose` as a peer dependency so you can bring your own compatible version.

```sh
npm install mongoose
npm install ./MongoDB_artificialbrains_KG
```


## Quick start

This section walks you through a simple setup where a `User` model is mapped to a single `person` node and an edge to its organisation.  The same approach works for teams, memories or any other collection.

### 1. Initialise the SDK

Before binding models you must provide the SDK with the Mongoose models it should use to store graph data, and if using Vector, to Voyage AI.  These models represent your `nodes` and `edges` (relationships) collections. 

```js
const mongoose = require('mongoose');
const { kgInit } = require('MongoDB_artificialbrains_KG');

const NodesModel = require('./models/nodes');
const EdgesModel = require('./models/edges');
const UserGroup = require('./models/user_group');

// Pass any additional repositories via `repos` if you need them inside your edge functions
kgInit({
  nodesModel: NodesModel,
  edgesModel: EdgesModel,
  repos: { UserGroup }
});
```

#### 1a. Create graph models automatically

If you don’t already have collections defined for your graph you can let the SDK create them for you.  The helper `createGraphModels()` builds Mongoose schemas with sensible defaults and indexes.  You can specify additional fields for the `properties` objects and allowed values for `type` and `relationship`.

```js
const mongoose = require('mongoose');
const { createGraphModels, kgInit } = require('MongoDB_artificialbrains_KG');

// Define enumerations for valid node types and relationships
const nodeTypes = ['person', 'team', 'organization', 'memory'];
const relationships = ['works_at', 'member_of', 'memory_of'];

// Build the models with custom fields.  You can mark fields as indexed.
const { NodeModel, EdgeModel } = createGraphModels({
  node: {
    name: 'NodesKG',
    customFields: {
      name: { type: String, index: true },
      email: { type: String, index: true },
      role: { type: String }
    },
    typeEnum: nodeTypes
  },
  edge: {
    name: 'EdgesKG',
    customFields: {
      context: { type: String },
      role: { type: String },
      start_date: { type: Date }
    },
    relationshipEnum: relationships
  },
  connection: mongoose
});

// Initialise the SDK with the generated models
kgInit({ nodesModel: NodeModel, edgesModel: EdgeModel });
```

The generated schemas automatically create indexes on common fields (`id`, `type`, `org_id`, etc.) to keep your queries fast.

### 2. Define a mapping for your model

Use `bindModel()` to tell the SDK how to convert a document into a node and which edges should be created.  The config object accepts three functions:

* `node(doc)` – returns a plain object describing the node; must include a unique `id`.
* `edges(doc, ctx)` – returns an array of plain objects describing the edges; optional.
* `cleanup(doc)` – returns an array of filters used to remove edges and nodes when the document is deleted; optional.

```js
const { bindModel, Relationship } = require('MongoDB_artificialbrains_KG');

bindModel(UserModel, {
  node: (u) => ({
    id: `user_${u._id}`,
    label: u.name || 'Unnamed User',
    type: 'person',
    org_id: u.org_id,
    source_collection: 'users',
    source_id: u._id,
    properties: {
      email: u.email,
      role: u.role
    }
  }),
  edges: (u) => ([{
    id: `user_${u._id}_works_at_${u.org_id}`,
    source: `user_${u._id}`,
    target: `organization_${u.org_id}`,
    relationship: Relationship.WorksAt,
    org_id: u.org_id
  }]),
  cleanup: (u) => [
    { source: `user_${u._id}` },
    { id: `user_${u._id}` }
  ]
});
```

The SDK will automatically attach middleware to your model.  When a user document is created or updated the node and edges will be upserted; when it is removed the corresponding node and edges will be deleted.

### 3. Query the graph

Your graph data lives in the collections backed by `nodesModel` and `edgesModel`.  To render a graph on the front end simply return these arrays from a route:

```js
app.get('/api/graph', async (req, res) => {
  const org = req.user.org_id;
  const [nodes, edges] = await Promise.all([
    NodesModel.find({ org_id: org }).lean(),
    EdgesModel.find({ org_id: org }).lean()
  ]);
  res.json({ nodes, edges });
});
```

On the client side you can consume this data with a D3 visualiser or any other graph library.  An example D3 component is included below.

## API reference

### `kgInit(options)`

Initialises the SDK.  **Must** be called before using any other function.  Options:

| option        | type      | description                                                  |
|---------------|-----------|--------------------------------------------------------------|
| nodesModel    | Mongoose model | Required.  Model that stores your graph nodes.         |
| edgesModel    | Mongoose model | Required.  Model that stores your graph edges.         |
| repos         | object    | Optional.  Additional repositories accessible in edge rules. |
| options       | object    | Optional.  Reserved for future use.                         |

### `createNode(node)`

Upserts a single node.  You generally won’t use this directly once your models are bound, but it’s available for ad‑hoc tasks such as seeding data.

### `createEdge(edge)`

Upserts a single edge.  Use this for manual updates when you do not need automatic syncing.

### `kgBulkSync({ desiredNodes, desiredEdges, org_id, keepExtra })`

Efficiently synchronises many nodes and edges in one call.  Pass arrays of nodes and edges along with the organisation.  By default the SDK removes any edge originating from one of the provided nodes that does not appear in the `desiredEdges` array.  You can opt out of this pruning by setting `keepExtra.edges = true`.

### `bindModel(model, config)`

Attaches middleware to a Mongoose model so that its documents are mirrored into the graph.  The `config` object must define at least a `node(doc)` function.  Optional properties:

| property | type | description |
|---|---|---|
| `node(doc)` | function | Returns a plain object describing the canonical graph node for the document.  Must have a unique `id` string. |
| `edges(doc, ctx)` | function | Returns an array of edge objects to create.  Receives the document and the current context (`{ nodesModel, edgesModel, repos }`).  Async functions are supported. |
| `cleanup(doc)` | function | Returns an array of filter objects used when deleting the document.  Each filter is passed directly to `edgesModel.deleteMany()`.  The node will always be deleted regardless. |
| `options` | object | Reserved for future use. |

### `createGraphModels(options)`

Factory for building node and edge models with sensible defaults.  Use this when you don’t already have Mongoose models for your graph data.

Options:

| option                | type              | description                                                                        |
|-----------------------|-------------------|------------------------------------------------------------------------------------|
| `node.name`           | string            | Name of the node model (defaults to `GraphNode`).                                 |
| `node.customFields`   | object            | Additional fields on the `properties` object for nodes.  Each key can be a type constructor or an object with `type` and an optional `index` boolean. |
| `node.extraProperties`| object            | (Deprecated) Additional schema definition for the `properties` field on nodes.  Prefer `customFields`. |
| `node.typeEnum`       | string[]          | Allowed values for the `type` field; leave empty to accept any string.            |
| `edge.name`           | string            | Name of the edge model (defaults to `GraphEdge`).                                 |
| `edge.customFields`   | object            | Additional fields on the `properties` object for edges.  Keys can be type constructors or objects with `type` and optional `index`. |
| `edge.extraProperties`| object            | (Deprecated) Additional schema definition for the `properties` field on edges.  Prefer `customFields`. |
| `edge.relationshipEnum` | string[]        | Allowed values for the `relationship` field; leave empty to accept any string.    |
| `connection`          | Mongoose Connection | Optional connection; uses the default connection if omitted.                      |

Returns an object of the form `{ NodeModel, EdgeModel }`.  The generated schemas include indexes on `id`, `type`, `org_id` and other frequently queried fields to keep lookups fast.

### `defineEntityType(template)`

Optional helper to build reusable configurations.  It simply returns the template you pass in – use it to share common patterns across your models.

### `NodeType` and `Relationship`

Enumerations containing common node types and relationships.  These strings are provided as a convenience; you are free to use your own values.

## Example D3 visualisation

The SDK does not dictate how you should render your graph.  Below is a minimal example of a D3 component that accepts the `{ nodes, edges }` returned by your API (Backend) and draws an interactive force‑directed graph. Make sure to include https://d3js.org/d3.v7.min.js to your scrip.

```html
<div id="graph" style="height: 800px"></div>
<script type="module">
  import * as d3 from 'd3';

  class GraphVisualizer {
    constructor(selector, { width = 800, height = 600 } = {}) {
      this.svg = d3.select(selector)
        .append('svg')
        .attr('width', width)
        .attr('height', height);
    }
    render({ nodes, edges }) {
      const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(edges).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(400, 300));
      const link = this.svg.selectAll('.link')
        .data(edges)
        .enter()
        .append('line')
        .attr('class', 'link')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6);
      const node = this.svg.selectAll('.node')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', 'node')
        .call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }));
      node.append('circle')
        .attr('r', 5)
        .attr('fill', d => {
          switch (d.type) {
            case 'person': return '#81C7D4';
            case 'team': return '#7FA6EE';
            case 'organization': return '#FDD663';
            case 'memory': return '#F28B82';
            default: return '#999999';
          }
        });
      node.append('text')
        .text(d => d.label)
        .attr('dx', 8)
        .attr('dy', 4)
        .style('font-size', '10px');
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node
          .attr('transform', d => `translate(${d.x}, ${d.y})`);
      });
    }
  }
  // Fetch graph data from your API and render it
  fetch('/api/graph')
    .then(res => res.json())
    .then(data => {
      const viz = new GraphVisualizer('#graph', { width: 800, height: 800 });
      viz.render(data);
    });
</script>
```

## License

APACHE 2.0