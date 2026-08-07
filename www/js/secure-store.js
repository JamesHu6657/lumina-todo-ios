/**
 * 密钥存储：iOS 真机走 Keychain（LuminaSecureStore 原生插件），
 * 浏览器/无插件时回退 localStorage；原生插件出现错误时绝不静默降级。
 * 启动时把旧 localStorage 中的密钥迁到 Keychain 并删除明文副本。
 */
(function (root) {
  "use strict";

  const MIGRATED_FLAG = "lumina-secure-migrated-v1";

  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, val);
      return true;
    } catch {
      return false;
    }
  }
  function lsRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  function nativePlugin() {
    try {
      return root.Capacitor?.Plugins?.LuminaSecureStore || null;
    } catch {
      return null;
    }
  }

  function keychainError(action, code, cause) {
    const err = new Error(`Keychain ${action}失败，请稍后重试`);
    err.code = code;
    if (cause) err.cause = cause;
    return err;
  }

  async function get(key) {
    const k = String(key || "");
    if (!k) return null;
    const plugin = nativePlugin();
    if (plugin?.get) {
      try {
        const r = await plugin.get({ key: k });
        if (r && typeof r.value === "string") return r.value;
        if (r && r.value == null) return null;
      } catch (cause) {
        // 真机 Keychain 不可用时不能把密钥重新暴露到 localStorage。
        throw keychainError("读取", "KEYCHAIN_READ_FAILED", cause);
      }
    }
    return lsGet(k);
  }

  async function set(key, value) {
    const k = String(key || "");
    if (!k) return false;
    const v = String(value ?? "");
    const plugin = nativePlugin();
    if (plugin?.set) {
      try {
        await plugin.set({ key: k, value: v });
        // 成功写入 Keychain 后清掉 localStorage 明文，避免双写
        lsRemove(k);
        return true;
      } catch {
        return false;
      }
    }
    return lsSet(k, v);
  }

  async function remove(key) {
    const k = String(key || "");
    if (!k) return true;
    const plugin = nativePlugin();
    if (plugin?.remove) {
      try {
        await plugin.remove({ key: k });
      } catch {
        return false;
      }
    }
    lsRemove(k);
    return true;
  }

  /**
   * 把指定 key 从 localStorage 迁到 Keychain（若插件可用且目标为空）。
   * 返回最终可用的值。迁移失败会抛出可识别错误，避免把残留明文伪装成“未配置”。
   */
  async function migrateKey(key) {
    const k = String(key || "");
    if (!k) return null;
    const plugin = nativePlugin();
    const legacy = lsGet(k);
    if (!plugin?.get || !plugin?.set) return legacy;

    try {
      const r = await plugin.get({ key: k });
      const existing = r && typeof r.value === "string" ? r.value : null;
      if (existing) {
        if (legacy) lsRemove(k);
        return existing;
      }
      if (legacy) {
        await plugin.set({ key: k, value: legacy });
        lsRemove(k);
        return legacy;
      }
    } catch {
      const err = new Error("Keychain 迁移失败");
      err.code = "KEYCHAIN_MIGRATE_FAILED";
      throw err;
    }
    return null;
  }

  async function migrateSecrets(keys) {
    const list = Array.isArray(keys) ? keys : [];
    const out = {};
    for (const key of list) {
      out[key] = await migrateKey(key);
    }
    try {
      lsSet(MIGRATED_FLAG, "1");
    } catch {
      /* ignore */
    }
    return out;
  }

  function backend() {
    return nativePlugin() ? "keychain" : "localStorage";
  }

  root.LUMINA_SECURE_STORE = {
    get,
    set,
    remove,
    migrateKey,
    migrateSecrets,
    backend,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
