function isEtsyVariationSelectId(value) {
  return /^variation-selector-\d+$/.test(String(value || ''));
}

function marketplaceVariationSelector(id) {
  if (!isEtsyVariationSelectId(id)) throw new Error('Unsupported Etsy variation selector');
  return `#${id}`;
}

function changedEtsyVariationSelections(previousSelections, selections) {
  const previous = previousSelections instanceof Map ? previousSelections : new Map();
  return (Array.isArray(selections) ? selections : [])
    .filter((selection) => selection && previous.get(selection.selector) !== selection.value);
}

module.exports = { changedEtsyVariationSelections, isEtsyVariationSelectId, marketplaceVariationSelector };
