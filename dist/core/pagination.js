export function paginate(items, options) {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 20)));
    return {
        items: items.slice(offset, offset + limit), total: items.length, offset, limit,
        nextOffset: offset + limit < items.length ? offset + limit : null,
    };
}
//# sourceMappingURL=pagination.js.map