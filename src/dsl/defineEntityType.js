/**
 * A helper to create reusable entity type definitions.  It simply
 * returns the template you provide.  Use this to DRY up common
 * configurations when binding multiple models that share the same
 * shape.
 *
 * @param {Object} template - A configuration object for bindModel()
 * @returns {Object} A shallow copy of the template
 */
function defineEntityType(template) {
  return Object.assign({}, template);
}

module.exports = {
  defineEntityType
};