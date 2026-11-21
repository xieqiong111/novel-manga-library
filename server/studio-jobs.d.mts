export declare function studioDelegated(env?: NodeJS.ProcessEnv): boolean
export declare function studioJob<T = unknown>(
  pathname: string,
  options?: { method?: 'GET' | 'POST'; body?: object; query?: Record<string, string | number | boolean | undefined> },
  env?: NodeJS.ProcessEnv,
): Promise<T>
export declare function searchStudioWork<T = Record<string, unknown>>(
  kind: 'novel' | 'manga',
  options: { query: string; bangumiSubjectId?: number; sourceQuery?: string; alternateNames?: string[];
    [key: string]: string | string[] | number | boolean | undefined },
): Promise<T>
