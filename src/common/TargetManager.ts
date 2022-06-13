/**
 * Copyright 2022 Google Inc. All rights reserved.
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

import Protocol from 'devtools-protocol';
import {assert} from './assert.js';
import {CDPSession, Connection} from './Connection.js';
import {EventEmitter} from './EventEmitter.js';
import {Target} from './Target.js';
import {debug} from './Debug.js';
import {debugError} from './util.js';

type TargetFilterCallback = (target: Protocol.Target.TargetInfo) => boolean;

type TargetFactory = (
  targetInfo: Protocol.Target.TargetInfo,
  session?: CDPSession
) => Target;

type TargetAttachHook = (
  createdTarget: Target,
  parentTarget: Target | null
) => Promise<void>;

const debugTargetManager = debug('puppeteer:targetManager:workflow');

class TrackedMap<Key, Value> {
  #data: Map<Key, Value> = new Map();
  #debug: (...args: unknown[]) => void;

  constructor(debug: (...args: unknown[]) => void) {
    this.#debug = debug;
  }

  set(key: Key, value: Value) {
    this.#debug(`Setting ${key} to`, value);
    if (this.#data.has(key)) {
      this.#debug(`Map already contains: key=${key}`);
    }
    this.#data.set(key, value);
  }

  has(key: Key): boolean {
    return this.#data.has(key);
  }

  delete(key: Key): void {
    if (!this.#data.has(key)) {
      this.#debug(`Map does not contain: key=${key}`);
    }
    this.#data.delete(key);
  }

  get(key: Key): Value | undefined {
    if (!this.has(key)) {
      this.#debug(`Map does not contain: key=${key}`);
    }
    return this.#data.get(key);
  }

  toMap(): Map<Key, Value> {
    return new Map(this.#data);
  }
}

/**
 * TargetManager encapsulates all interactions with CDP targets.
 * Core outside of this class should not subscribe `Target.*` events
 * and only use the TargetManager events.
 */
export class TargetManager extends EventEmitter {
  #connection: Connection;
  #discoveredTargetsByTargetId: TrackedMap<string, Protocol.Target.TargetInfo> =
    new TrackedMap(
      debug('puppeteer:targetManager:discoveredTargetsByTargetId')
    );
  #attachedTargetsByTargetId: TrackedMap<string, Target> = new TrackedMap(
    debug('puppeteer:targetManager:attachedTargetsByTargetId')
  );
  #attachedTargetsBySessionId: TrackedMap<string, Target> = new TrackedMap(
    debug('puppeteer:targetManager:attachedTargetsBySessionId')
  );
  #ignoredTargets = new Set<string>();
  #targetFilterCallback: TargetFilterCallback | undefined;
  #targetFactory: TargetFactory;

  #targetAttachHooks: WeakMap<CDPSession | Connection, TargetAttachHook[]> =
    new WeakMap();

  #attachedToTargetListenersBySession: WeakMap<
    CDPSession | Connection,
    (event: Protocol.Target.AttachedToTargetEvent) => Promise<void>
  > = new WeakMap();
  #detachedFromTargetListenersBySession: WeakMap<
    CDPSession | Connection,
    (event: Protocol.Target.DetachedFromTargetEvent) => void
  > = new WeakMap();

  #initializeCallback = () => {};
  #initializePromise: Promise<void> = new Promise(resolve => {
    this.#initializeCallback = resolve;
  });
  #targetsIdsForInit: Set<string> = new Set();

  constructor(
    connection: Connection,
    targetFactory: TargetFactory,
    targetFilterCallback?: TargetFilterCallback
  ) {
    super();
    this.#connection = connection;
    this.#targetFilterCallback = targetFilterCallback;
    this.#targetFactory = targetFactory;

    this.#connection.on('Target.targetCreated', this.#onTargetCreated);
    this.#connection.on('Target.targetDestroyed', this.#onTargetDestroyed);
    this.#connection.on('Target.targetInfoChanged', this.#onTargetInfoChanged);
    this.#connection.on('sessiondetached', this.#onSessionDetached);
    this.setupAttachmentListeners(this.#connection);

    this.#connection.send('Target.setDiscoverTargets', {discover: true});
  }

  addTargetAttachHook(
    client: CDPSession | Connection,
    cb: TargetAttachHook
  ): void {
    const list = this.#targetAttachHooks.get(client) || [];
    list.push(cb);
    this.#targetAttachHooks.set(client, list);
  }

  removeTargetAttachHook(
    client: CDPSession | Connection,
    cb: TargetAttachHook
  ): void {
    const list = this.#targetAttachHooks.get(client) || [];
    this.#targetAttachHooks.set(
      client,
      list.filter(item => {
        return item !== cb;
      })
    );
  }

  setupAttachmentListeners(session: CDPSession | Connection): void {
    const listener = (event: Protocol.Target.AttachedToTargetEvent) => {
      return this.#onAttachedToTarget(session, event);
    };
    assert(!this.#attachedToTargetListenersBySession.has(session));
    this.#attachedToTargetListenersBySession.set(session, listener);
    session.on('Target.attachedToTarget', listener);

    const detachedListener = (
      event: Protocol.Target.DetachedFromTargetEvent
    ) => {
      return this.#onDetachedFromTarget(session, event);
    };
    assert(!this.#detachedFromTargetListenersBySession.has(session));
    this.#detachedFromTargetListenersBySession.set(session, detachedListener);
    session.on('Target.detachedFromTarget', detachedListener);
  }

  #onSessionDetached = (session: CDPSession) => {
    this.removeSessionListeners(session);
    this.#targetAttachHooks.delete(session);
  };

  removeSessionListeners(session: CDPSession): void {
    if (this.#attachedToTargetListenersBySession.has(session)) {
      session.off(
        'Target.attachedToTarget',
        this.#attachedToTargetListenersBySession.get(session)!
      );
      this.#attachedToTargetListenersBySession.delete(session);
    }

    if (this.#detachedFromTargetListenersBySession.has(session)) {
      session.off(
        'Target.detachedFromTarget',
        this.#detachedFromTargetListenersBySession.get(session)!
      );
      this.#detachedFromTargetListenersBySession.delete(session);
    }
  }

  attachedTargets(): Map<string, Target> {
    return this.#attachedTargetsByTargetId.toMap();
  }

  dispose(): void {
    this.#connection.off('Target.targetCreated', this.#onTargetCreated);
    this.#connection.off('Target.targetDestroyed', this.#onTargetDestroyed);
    this.#connection.off('Target.targetInfoChanged', this.#onTargetInfoChanged);
  }

  async initialize(): Promise<void> {
    this.#targetsIdsForInit = new Set(
      this.#discoveredTargetsByTargetId.toMap().keys()
    );
    await this.#connection.send('Target.setAutoAttach', {
      waitForDebuggerOnStart: true,
      flatten: true,
      autoAttach: true,
    });
    await this.#initializePromise;
  }

  #onTargetCreated = async (event: Protocol.Target.TargetCreatedEvent) => {
    this.#discoveredTargetsByTargetId.set(
      event.targetInfo.targetId,
      event.targetInfo
    );

    if (event.targetInfo.type === 'browser' && event.targetInfo.attached) {
      if (this.#attachedTargetsByTargetId.has(event.targetInfo.targetId)) {
        return;
      }
      const target = this.#targetFactory(event.targetInfo, undefined);
      this.#attachedTargetsByTargetId.set(event.targetInfo.targetId, target);
    }

    if (event.targetInfo.type === 'shared_worker') {
      // Special case (https://crbug.com/1338156): currently, shared_workers
      // don't get auto-attached. This should be removed once the auto-attach
      // works.
      await this.#connection.createSession(event.targetInfo);
    }
  };

  #onTargetDestroyed = (event: Protocol.Target.TargetDestroyedEvent) => {
    this.#discoveredTargetsByTargetId.delete(event.targetId);
    this.#checkInit(event.targetId);
  };

  #onTargetInfoChanged = (event: Protocol.Target.TargetInfoChangedEvent) => {
    this.#discoveredTargetsByTargetId.set(
      event.targetInfo.targetId,
      event.targetInfo
    );

    if (
      this.#ignoredTargets.has(event.targetInfo.targetId) ||
      !this.#attachedTargetsByTargetId.has(event.targetInfo.targetId) ||
      !event.targetInfo.attached
    ) {
      return;
    }

    const target = this.#attachedTargetsByTargetId.get(
      event.targetInfo.targetId
    );
    this.emit(TargetManagerEmittedEvents.TargetChanged, {
      target: target!,
      targetInfo: event.targetInfo,
    });
  };

  #onAttachedToTarget = async (
    parentSession: Connection | CDPSession,
    event: Protocol.Target.AttachedToTargetEvent
  ) => {
    debugTargetManager(
      'Attached to session',
      'parentSession',
      parentSession instanceof CDPSession ? parentSession.id() : 'main',
      'event',
      event
    );
    const targetInfo = event.targetInfo;
    const session = this.#connection.session(event.sessionId);
    if (!session) {
      throw new Error(`Session ${event.sessionId} was not created.`);
    }

    // 1) From here on, we should either detach the session or keep it.

    // Should silently detach? Currently, only service workers attached to
    // not-main targets have to be detached.
    // See https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/devtools_agent_host_impl.cc?ss=chromium&q=f:devtools%20-f:out%20%22::kTypePage%5B%5D%22
    // for the complete list of available types.
    if (
      targetInfo.type === 'service_worker' &&
      parentSession instanceof CDPSession
    ) {
      this.#checkInit(targetInfo.targetId);
      debugTargetManager(
        'Silently detaching a session',
        'parentSession',
        parentSession instanceof CDPSession ? parentSession.id() : 'main',
        'targetInfo',
        targetInfo
      );
      await session.send('Runtime.runIfWaitingForDebugger').catch(debugError);
      await parentSession
        .send('Target.detachFromTarget', {
          sessionId: session.id(),
        })
        .catch(debugError);
      // When we detach silently, we don't register the session/target in any maps.
      return;
    }

    // 2) Here we check the target filter and silently detach from targes that
    //    don't match. It is similar to the previous branch so perhaps except
    //    with record the targetId in ignoredTargets.
    if (this.#targetFilterCallback && !this.#targetFilterCallback(targetInfo)) {
      this.#ignoredTargets.add(targetInfo.targetId);
      this.#checkInit(targetInfo.targetId);
      await session.send('Runtime.runIfWaitingForDebugger').catch(debugError);
      await parentSession
        .send('Target.detachFromTarget', {
          sessionId: session.id(),
        })
        .catch(debugError);
      // When we detach silently, we don't register the session/target in any maps.
      return;
    }

    // 3) At this point, we are sure that the session exists and that the target
    //    should be attached to. One target might be attached to multiple
    //    sessions. Therefore, we need to check if we already attached to it.
    const existingTarget = this.#attachedTargetsByTargetId.has(
      targetInfo.targetId
    );

    const target = existingTarget
      ? this.#attachedTargetsByTargetId.get(targetInfo.targetId)!
      : this.#targetFactory(targetInfo, session);

    // 4) Set up listeners for the session so that session events are received.
    this.setupAttachmentListeners(session);

    // 5) Update the maps
    if (existingTarget) {
      this.#attachedTargetsBySessionId.set(
        session.id(),
        this.#attachedTargetsByTargetId.get(targetInfo.targetId)!
      );
    } else {
      this.#attachedTargetsByTargetId.set(targetInfo.targetId, target);
      this.#attachedTargetsBySessionId.set(session.id(), target);
    }

    // 6) At this point the target is paused so we can allow clients to
    //    configure themselves using hooks.
    for (const hook of this.#targetAttachHooks.get(parentSession) || []) {
      if (!(parentSession instanceof Connection)) {
        assert(this.#attachedTargetsBySessionId.has(parentSession.id()));
      }
      await hook(
        target,
        parentSession instanceof Connection
          ? null
          : this.#attachedTargetsBySessionId.get(parentSession.id())!
      );
    }

    // 7) Track if the tar‚get gas been initialized.
    this.#targetsIdsForInit.delete(target._targetId);
    this.emit(TargetManagerEmittedEvents.AttachedToTarget, target);
    if (this.#targetsIdsForInit.size === 0) {
      this.#initializeCallback();
    }

    // 8) Actually resume the target and configure auto-attach.
    await Promise.all([
      session.send('Target.setAutoAttach', {
        waitForDebuggerOnStart: true,
        flatten: true,
        autoAttach: true,
      }),
      session.send('Runtime.runIfWaitingForDebugger'),
    ]).catch(debugError);
    // TODO: the browser might be shutting down here. What do we do with the
    // error?

    // 9) The service worker target needs to be detached. TODO: figure out if
    //    this is correct. if (targetInfo.type === 'service_worker') { await
    //    parentSession .send('Target.detachFromTarget', { sessionId:
    //    session.id(),
    //     })
    //     .catch(debugError);
    //    }
  };

  #checkInit(targetId: string): void {
    this.#targetsIdsForInit.delete(targetId);
    if (this.#targetsIdsForInit.size === 0) {
      this.#initializeCallback();
    }
  }

  #onDetachedFromTarget = (
    parentSession: Connection | CDPSession,
    event: Protocol.Target.DetachedFromTargetEvent
  ) => {
    debugTargetManager(
      'Detached from session',
      'parentSession',
      parentSession instanceof CDPSession ? parentSession.id() : 'main',
      'event',
      event
    );

    const target = this.#attachedTargetsBySessionId.get(event.sessionId);

    this.#attachedTargetsBySessionId.delete(event.sessionId);

    if (!target) {
      return;
    }

    this.#attachedTargetsByTargetId.delete(target._targetId);
    this.emit(TargetManagerEmittedEvents.DetachedFromTarget, target);
  };
}

/**
 * @internal
 */
export const enum TargetManagerEmittedEvents {
  AttachedToTarget = 'attachedToTarget',
  DetachedFromTarget = 'detachedFromTarget',
  TargetChanged = 'targetChanged',
}
