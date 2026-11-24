// ===== Cloud Sync 前端模块 =====
// 无账号体系的云端备份：DID(设备) + BID(云端备份ID) + secret(恢复码)
// 调用 Supabase Edge Function 完成 upload / download / activity

(function (global) {
  "use strict";

  // ---------- 服务端配置 ----------
  // Edge Function 地址（从浏览器访问的公开地址）
  // 如果换了项目或函数名，改这里就行
  var FUNCTION_URL = "https://jaaqjvwbtmalpajcyfkp.supabase.co/functions/v1/rapid-handler";

  // ---------- localStorage 键 ----------
  var DID_KEY = "early-literacy-did";         // 设备安装 ID，整个浏览器实例唯一
  var BID_PREFIX = "early-literacy-bid:";    // 每个小朋友一个 BID，key 格式: bid:<uid>
  var SECRET_PREFIX = "early-literacy-secret:"; // 每个小朋友一个 secret
  var REVISION_PREFIX = "early-literacy-rev:";  // 每个小朋友的云端版本号

  // ---------- DID ----------
  function getDid() {
    var did = localStorage.getItem(DID_KEY);
    if (did) return did;
    did = "d-" + (global.crypto && crypto.randomUUID ? crypto.randomUUID() : fallbackUuid());
    localStorage.setItem(DID_KEY, did);
    return did;
  }

  function fallbackUuid() {
    // 不支持 crypto.randomUUID 时的兜底
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---------- BID / secret / revision ----------
  // 每个小朋友独立一份云端备份
  function bidKey(uid) { return BID_PREFIX + uid; }
  function secretKey(uid) { return SECRET_PREFIX + uid; }
  function revisionKey(uid) { return REVISION_PREFIX + uid; }

  function getBid(uid) {
    return localStorage.getItem(bidKey(uid)) || null;
  }

  function getSecret(uid) {
    return localStorage.getItem(secretKey(uid)) || null;
  }

  function getRevision(uid) {
    var v = parseInt(localStorage.getItem(revisionKey(uid)) || "0", 10);
    return isNaN(v) ? 0 : v;
  }

  function setBid(uid, bid) {
    localStorage.setItem(bidKey(uid), bid);
  }

  function setSecret(uid, secret) {
    localStorage.setItem(secretKey(uid), secret);
  }

  function setRevision(uid, rev) {
    localStorage.setItem(revisionKey(uid), String(rev));
  }

  // 生成新的云端绑定（首次上传时调用）
  function createNewBinding(uid) {
    var did = getDid();
    var bid = did + ":" + uid;
    var secret = generateSecret();
    setBid(uid, bid);
    setSecret(uid, secret);
    setRevision(uid, 0);
    return { bid: bid, secret: secret };
  }

  // 高熵恢复码：32 字节 base32，人类可手写
  function generateSecret() {
    var bytes = new Uint8Array(32);
    global.crypto.getRandomValues(bytes);
    var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉易混字符 I/O/0/1
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push(alphabet[bytes[i] % alphabet.length]);
    }
    // 分成 4 字符一组方便阅读
    return out.join("").match(/.{1,4}/g).join("-");
  }

  // ---------- 从恢复码恢复绑定（换机时调用） ----------
  // 用户输入老设备上复制的恢复码，恢复 BID + secret
  function bindFromRecoveryCode(uid, recoveryCode) {
    // 约定恢复码格式：前半段是 bid，后半段是 secret，用 "::" 分隔
    // 如果用户只粘了 secret（旧格式），则无法恢复
    var parts = recoveryCode.split("::");
    if (parts.length !== 2) {
      throw new Error("恢复码格式不正确，请确认完整复制了老设备上的恢复码。");
    }
    var bid = parts[0].trim();
    var secret = parts[1].trim();
    if (!bid || !secret) {
      throw new Error("恢复码不完整。");
    }
    setBid(uid, bid);
    setSecret(uid, secret);
    // revision 清 0，下载成功后会更新
    setRevision(uid, 0);
    return { bid: bid, secret: secret };
  }

  // ---------- 构建恢复码 ----------
  function buildRecoveryCode(uid) {
    var bid = getBid(uid);
    var secret = getSecret(uid);
    if (!bid || !secret) return null;
    return bid + "::" + secret;
  }

  // ---------- HTTP 调用 ----------

  function post(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    return fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        data._status = res.status;
        return data;
      });
    });
  }

  // ---------- 业务：上传 ----------
  // uid: 小朋友本地 ID
  // payload: Storage.exportUserData() 的输出
  // 返回 { ok, revision, conflict? }
  function upload(uid, payload) {
    var binding = {
      bid: getBid(uid),
      secret: getSecret(uid),
    };
    var isNew = !binding.bid;

    if (isNew) {
      binding = createNewBinding(uid);
    }

    return post("upload", {
      bid: binding.bid,
      secret: binding.secret,
      data: payload,
      base_revision: isNew ? null : getRevision(uid),
      app_version: global.APP_VERSION || null,
      backup_name: payload.user ? payload.user.name : null,
    }).then(function (result) {
      if (result.ok) {
        setRevision(uid, result.revision);
        return { ok: true, revision: result.revision, isNew: isNew };
      }
      // 冲突时返回服务端版本信息
      if (result.conflict) {
        return {
          ok: false,
          conflict: true,
          server_revision: result.server_revision,
          server_updated_at: result.server_updated_at,
          recovery_code: buildRecoveryCode(uid),
        };
      }
      return { ok: false, error: result.error || "上传失败" };
    }).catch(function (err) {
      return { ok: false, error: "网络错误：" + (err.message || err) };
    });
  }

  // ---------- 业务：下载 ----------
  // recoveryCode: 恢复码（包含 bid::secret）
  // 返回 { ok, payload, revision }
  function download(recoveryCode) {
    var binding;
    try {
      binding = parseRecoveryCode(recoveryCode);
    } catch (e) {
      return Promise.resolve({ ok: false, error: e.message });
    }

    return post("download", {
      bid: binding.bid,
      secret: binding.secret,
    }).then(function (result) {
      if (result.ok) {
        return {
          ok: true,
          payload: result.payload,
          revision: result.revision,
          updated_at: result.updated_at,
          backup_name: result.backup_name,
          bid: binding.bid,
          secret: binding.secret,
        };
      }
      return { ok: false, error: result.error || "下载失败" };
    }).catch(function (err) {
      return { ok: false, error: "网络错误：" + (err.message || err) };
    });
  }

  function parseRecoveryCode(code) {
    var parts = code.split("::");
    if (parts.length !== 2) throw new Error("恢复码格式不正确。");
    return { bid: parts[0].trim(), secret: parts[1].trim() };
  }

  // ---------- 业务：活跃上报 ----------
  // 每次打开应用或开始练习时调用（去重由服务端 upsert 保证）
  function reportActivity(uid, type) {
    var actorType = type === "device" ? "device" : "child";
    var actorId = actorType === "device" ? getDid() : (getDid() + ":" + uid);

    // 静默上报，不阻塞主流程
    post("activity", {
      actor_type: actorType,
      actor_id: actorId,
    }).catch(function () { /* 忽略网络失败 */ });
  }

  // ---------- 清理（仅调试用） ----------
  function resetBinding(uid) {
    localStorage.removeItem(bidKey(uid));
    localStorage.removeItem(secretKey(uid));
    localStorage.removeItem(revisionKey(uid));
  }

  // ---------- 导出到全局 ----------
  global.Cloud = {
    FUNCTION_URL: FUNCTION_URL,
    getDid: getDid,
    getBid: getBid,
    getSecret: getSecret,
    getRevision: getRevision,
    setRevision: setRevision,
    hasBinding: function (uid) { return !!getBid(uid); },
    createNewBinding: createNewBinding,
    bindFromRecoveryCode: bindFromRecoveryCode,
    buildRecoveryCode: buildRecoveryCode,
    upload: upload,
    download: download,
    reportActivity: reportActivity,
    resetBinding: resetBinding,
  };
})(window);
