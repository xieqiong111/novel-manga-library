export declare function studioDelegated(env?: NodeJS.ProcessEnv): boolean
export declare function studioJob<T = unknown>(
  pathname: string,
  options?: { method?: 'GET' | 'POST'; body?: object; query?: Record<string, string | number | boolean | undefined> },
  env?: NodeJS.ProcessEnv,
): Promise<T>
