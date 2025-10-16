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
npm install ./mongodb-kg
```


## Quick start

This section walks you through a simple setup where `users` node is mapped via `comments` (edges) to a single `movie` node. The same approach works for any other collection (in the mflix example we create nodes for users, movies, theaters and comments).

### 1. Initialise the SDK

Before binding models you must provide the SDK with the Mongoose models it should use to store graph data. These models represent your `nodes` and `edges` (relationships) collections. 

```js
const mongoose = require('mongoose');

// function to initialize nodes and edges
const { kgInit } = require('mongodb-kg');


const NodesModel = require('./models/nodes');
const EdgesModel = require('./models/edges');

// 
const MflixMovie   = require('./models/movies');
const MflixUser    = require('./models/users');
const MflixComment = require('./models/comments');

// Pass any additional repositories via `repos` if you need them inside your edge functions
kgInit({
  nodesModel: NodesModel,
  edgesModel: EdgesModel,
  repos: { MflixMovie, MflixUser, MflixComment }
});
```

#### 1a. Create graph models automatically

If you don’t already have collections defined for your graph you can let the SDK create them for you.  The helper `createGraphModels()` builds Mongoose schemas with sensible defaults and indexes. You can specify additional fields for the `properties` objects and allowed values for `type` and `relationship`. 

By default, the generated schemas automatically create indexes on common fields. Nodes predefine and enforces the following fields:    
    id: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true, enum: typeEnum },
    source_collection: { type: String, required: true },
    source_id: { type: mongoose.Schema.Types.ObjectId, required: true },

Edges enforces the following:
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },

When initiating nodes and edges, you don't need to add those, but only the additional fields you want, inidicating if index is necessary. 

```js
const mongoose = require('mongoose');
const { createGraphModels, kgInit } = require('mongodb-kg');

// Define enumerations for valid node types and relationships
const nodeTypes = ['user', 'movie', 'comment', 'theater'];
const relationships = ['commented_on']; // in the mflix example, other potential relationships ['screened_at']

// Build the models with custom fields.  You can mark fields as indexed.
const { NodeModel, EdgeModel } = createGraphModels({
  node: {
    name: 'NodesKG',
    customFields: {
      title: { type: String, index: true }, // e.g. from the movies collection
      year: { type: String, index: true }, // idem
      plot: { type: String }, // idem
      name: { type: String, index: true }, // from users collection
    },
    typeEnum: nodeTypes
  },
  edge: {
    name: 'EdgesKG',
    customFields: {
      text: { type: String },
    },
    relationshipEnum: relationships
  },
  connection: mongoose
});

// Initialise the SDK with the generated models
kgInit({ nodesModel: NodeModel, edgesModel: EdgeModel });
```



### 2. Define a mapping for your model

Use `bindModel()` to tell the SDK how to convert a document into a node and which edges should be created.  The config object accepts three functions:

* `node(doc)` – returns a plain object describing the node; must include a unique `id`. Different from default _id
* `edges(doc, ctx)` – returns an array of plain objects describing the edges; optional.
* `cleanup(doc)` – returns an array of filters used to remove edges and nodes when the document is deleted; optional.

```js
const { bindModel, Relationship } = require('mongodb-kg');

  // HERE WE DEFINE THE MIDDLEWARE FOR MOVIES (IN THIS CASE, WE ONLY WANT NODES)
  bindModel(MflixMovie.schema, {
    node: (m) => ({
      id: `movie-${m._id}`,
      label: m.title || 'Untitled Movie',
      type: 'movie',
      source_collection: 'movies',
      source_id: m._id,
      properties: { year: m.year, imdb_rating: m.imdb?.rating, genres: m.genres }
    }),
    cleanup: (m) => [
      { source: `movie-${m._id}`},
      { target: `movie-${m._id}`}
    ]
  });

// HERE WE DEFINE THE MIDDLEWARE FOR COMMENTS (IN THIS CASE, WANT A NODE FOR COMMENTER AND EDGE CONNECTING COMMENTER WITH THE MOVIE NODE)
bindModel(MflixComment.schema, {
    node: (c) => ({
      id: `user-${c._id}`,
      label: c.name || 'Commenter',
      type: 'user',
      source_collection: 'comments',
      source_id: c._id,
      comment: c.text
      properties: { email: c.email, from_comment: true }
    }),
    edges: (c) => {
      const commenter = `user-${c._id}`;
      const movie     = `movie-${c.movie_id}`;
      return [{
        id: `${commenter}_commented_on_${movie}`,
        source: commenter,
        target: movie,
        relationship: 'commented_on',
        weight: 1,
        properties: { date: c.date }
      }];
    },
    cleanup: (c) => [{ source: `user-${c._id}` }]
  });
```

The SDK will automatically attach middleware to your model.  When a user document is created or updated the node and edges will be upserted; when it is removed the corresponding node and edges will be deleted.

### 3. Query the graph

Your graph data lives in the collections backed by `nodesModel` and `edgesModel`.  To render a graph on the front end simply return these arrays from a route:

```js
app.get('/api/graph', async (req, res) => {
  const org = req.user.org_id;
  const [nodes, edges] = await Promise.all([
    NodesModel.find({}).lean(),
    EdgesModel.find({}).lean()
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

```js


// --- Helpers ---
const getNodeId = (d) => {
  // Always return a STRING id for nodes/links
  if (d && typeof d === 'object') {
    if (d.id != null)   return String(d.id);
    if (d._id != null)  return String(d._id);       // ObjectId -> string
    if (d.source_id != null) return String(d.source_id);
  }
  return String(d); // edge endpoints that are already strings
};

function getGraphFromGlobals() {
  if (Array.isArray(window.nodes) && Array.isArray(window.edges)) {
    // Coerce edge endpoints to strings right away (important)
    const edges = window.edges.map(e => ({
      ...e,
      source: getNodeId(e.source),
      target: getNodeId(e.target),
    }));
    return { nodes: window.nodes.map(n => ({ ...n })), edges };
  }
  if (window.GRAPH && Array.isArray(window.GRAPH.nodes) && Array.isArray(window.GRAPH.edges)) {
    const edges = window.GRAPH.edges.map(e => ({
      ...e,
      source: getNodeId(e.source),
      target: getNodeId(e.target),
    }));
    return { nodes: window.GRAPH.nodes.map(n => ({ ...n })), edges };
  }
  throw new Error('No graph data found. Inject window.nodes and window.edges in the page.');
}

function colorForType(t) {
  switch (t) {
    case 'user': return '#81C7D4';
    case 'movie': return '#F28B82';
    case 'theater': return '#7FA6EE';
    case 'organization': return '#FDD663';
    default: return '#999999';
  }
}

function computeDegrees(nodes, edges) {
  const idx = new Map(nodes.map(n => [getNodeId(n), n]));
  nodes.forEach(n => (n._deg = 0));
  edges.forEach(e => {
    const s = getNodeId(e.source);
    const t = getNodeId(e.target);
    if (idx.has(s)) idx.get(s)._deg++;
    if (idx.has(t)) idx.get(t)._deg++;
  });
}

function countCommentsByMovie(edges) {
  // Count "commented_on" edges by TARGET node (movie)
  const counts = new Map();
  for (const e of edges) {
    if (e.relationship !== 'commented_on') continue;
    const tgt = getNodeId(e.target);
    counts.set(tgt, (counts.get(tgt) || 0) + 1);
  }
  return counts;
}

function filterGraphByMinComments({ nodes, edges }, minComments) {
  const commentsPerMovie = countCommentsByMovie(edges);

  // Movies that meet the threshold
  const allowedMovieIds = new Set(
    [...commentsPerMovie.entries()]
      .filter(([, c]) => c >= minComments)
      .map(([id]) => id)
  );

  // Keep edges that go to those movies (and keep only commented_on, or keep all — your call)
  const keptEdges = edges.filter(e => {
    const tgt = getNodeId(e.target);
    return allowedMovieIds.has(tgt);
  });

  // Keep the movies and the nodes that are incident to kept edges
  const keptNodeIds = new Set();
  for (const e of keptEdges) {
    keptNodeIds.add(getNodeId(e.source));
    keptNodeIds.add(getNodeId(e.target));
  }

  const keptNodes = nodes.filter(n => keptNodeIds.has(getNodeId(n)));

  return { nodes: keptNodes, edges: keptEdges, meta: { commentsPerMovie } };
}

function render({ nodes, edges }) {
  // Filter edges to only those whose endpoints exist among nodes
  const nodeKeySet = new Set(nodes.map(getNodeId));
  const safeEdges = edges.filter(e => nodeKeySet.has(getNodeId(e.source)) && nodeKeySet.has(getNodeId(e.target)));

  const container = d3.select('#graph');
  container.selectAll('*').remove();

  const width = container.node().clientWidth || 960;
  const height = container.node().clientHeight || 640;

  const svg = container.append('svg').attr('width', width).attr('height', height);
  const g = svg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  const simulation = d3.forceSimulation(nodes)
    // Use the STRING key for nodes
    .force('link', d3.forceLink(safeEdges).id(d => getNodeId(d)).distance(90))
    .force('charge', d3.forceManyBody().strength(-280))
    .force('center', d3.forceCenter(width / 2, height / 2));

  const link = g.selectAll('.link')
    .data(safeEdges)
    .enter().append('line')
    .attr('class', 'link')
    .attr('stroke', '#999')
    .attr('stroke-opacity', 0.6)
    .attr('stroke-width', d => Math.sqrt(d.weight || 1));

  link.append('title').text(d => {
    const from = (typeof d.source === 'object' ? (d.source.label || getNodeId(d.source)) : d.source);
    const to   = (typeof d.target === 'object' ? (d.target.label || getNodeId(d.target)) : d.target);
    const when = d.properties?.date ? new Date(d.properties.date).toLocaleString() : null;
    const txt  = d.properties?.text ? String(d.properties.text).replace(/\s+/g, ' ').slice(0, 240) : null;
    return [ `${from} → ${to}`, d.relationship ? `relation: ${d.relationship}` : null, when ? `on: ${when}` : null, txt ? `“${txt}”` : null ]
      .filter(Boolean).join('\n');
  });

  const node = g.selectAll('.node')
    .data(nodes)
    .enter().append('g').attr('class', 'node')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end',  (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  node.append('circle')
    .attr('r', d => Math.min(5 + Math.log((d._deg || 0) + 1) * 3, 22))
    .attr('fill', d => colorForType(d.type))
    .append('title')
    .text(d => `${d.type}: ${d.label ?? d.name ?? getNodeId(d)}`);

  node.append('text')
    .text(d => d.label ?? d.name ?? getNodeId(d))
    .attr('dx', 8).attr('dy', 4)
    .style('font-size', '10px')
    .style('pointer-events', 'none');

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  const counts = document.getElementById('counts');
  if (counts) counts.textContent = `nodes: ${nodes.length} • edges: ${safeEdges.length}`;

  return {
    resetView() { svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity); },
    restart() { simulation.alpha(1).restart(); },
  };
}

(function main() {
  try {
    const base = getGraphFromGlobals();             // full data from server
    window.__BASE_GRAPH__ = base;                   // stash for later

    computeDegrees(base.nodes, base.edges);
    render(base);

    // Reset
    const resetBtn = document.getElementById('reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const fresh = getGraphFromGlobals();
        computeDegrees(fresh.nodes, fresh.edges);
        render(fresh);
      });
    }

    // Apply "min comments" filter
    const applyBtn = document.getElementById('applyComments');
    const minInput = document.getElementById('minComments');
    if (applyBtn && minInput) {
      applyBtn.addEventListener('click', () => {
        const min = Math.max(0, parseInt(minInput.value, 10) || 0);
        const filtered = filterGraphByMinComments(window.__BASE_GRAPH__, min);
        computeDegrees(filtered.nodes, filtered.edges);
        render(filtered);
      });
    }
  } catch (e) {
    console.error(e);
    const badge = document.getElementById('counts');
    if (badge) badge.textContent = 'failed to load graph';
  }
})();
```

## License

APACHE 2.0 - 
want to collab - https://x.com/alexanderawolf
Support - https://buy.stripe.com/28E28q0TT6bo3jm5qC1RC00