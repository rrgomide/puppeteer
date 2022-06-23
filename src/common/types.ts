/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {JSHandle} from './JSHandle.js';
import {ElementHandle} from './ElementHandle.js';

export type AwaitableIteratable<T> = AsyncIterable<T> | Iterable<T>;
export type Awaitable<T> = T | PromiseLike<T>;

export type HandleFor<T> = T extends Node ? ElementHandle<T> : JSHandle<T>;
export type HandleOr<T> = HandleFor<T> | JSHandle<T> | T;

export type EvaluateParams<T extends unknown[]> = {
  [K in keyof T]: T[K] extends HandleOr<unknown> ? T[K] : HandleOr<T[K]>;
};
export type InnerParams<T extends unknown[]> = {
  [K in keyof T]: T[K] extends HandleOr<infer U> ? U : never;
};
export type EvaluateFunc<T extends unknown[]> = (
  ...params: InnerParams<T>
) => Awaitable<unknown>;
