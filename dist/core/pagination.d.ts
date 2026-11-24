export interface Page<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    nextOffset: number | null;
}
export declare function paginate<T>(items: T[], options: {
    offset?: number;
    limit?: number;
}): Page<T>;
