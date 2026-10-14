-- Behavioural test harness for the generated FiveM scripts.
--
-- Runs the REAL config.lua / client.lua / server.lua under plain Lua 5.4 against a mock of the
-- FiveM runtime (scheduler, natives, events). It cannot prove the game renders anything — it
-- proves the script's LOGIC: when natives are called, in what order, with which arguments, and
-- that nothing leaks, duplicates or spams.
--
-- usage: lua5.4 harness.lua <resource dir> <scenario>
-- exit status 0 = scenario passed; prints "PASS <name>" or "FAIL <name>: <reason>".

local dir, scenarioName = arg[1], arg[2]
assert(dir and scenarioName, 'usage: harness.lua <dir> <scenario>')

----------------------------------------------------------------------------------------------
-- tiny vector type (FiveM provides vector3 with arithmetic and #v length)
----------------------------------------------------------------------------------------------
local Vec = {}
Vec.__index = Vec
local function vec(x, y, z) return setmetatable({ x = x, y = y, z = z }, Vec) end
Vec.__sub = function(a, b) return vec(a.x - b.x, a.y - b.y, a.z - b.z) end
Vec.__add = function(a, b) return vec(a.x + b.x, a.y + b.y, a.z + b.z) end
Vec.__len = function(a) return math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) end

----------------------------------------------------------------------------------------------
-- world state + recorders
----------------------------------------------------------------------------------------------
local RES = 'test_resource'
local W -- the world, rebuilt per scenario
local calls, logs

local function joaat(s)
    local h = 0
    for i = 1, #s do
        h = (h + s:lower():byte(i)) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h = (h ~ (h >> 6)) & 0xFFFFFFFF
    end
    h = (h + (h << 3)) & 0xFFFFFFFF
    h = (h ~ (h >> 11)) & 0xFFFFFFFF
    h = (h + (h << 15)) & 0xFFFFFFFF
    return h
end

local function newWorld()
    return {
        now = 1000,
        threads = {},
        pendingAsset = nil,
        assetLoadDelay = 100, -- ms until HasNamedPtfxAssetLoaded turns true; math.huge = never
        assetRequestedAt = nil,
        ped = { weapon = 0, shooting = false, reloading = false, dead = false, coords = vec(0, 0, 0) },
        weaponEntity = 0, -- entity id of the held weapon; 0 = none yet
        weaponEntityDelay = 0, -- ms after selection before the weapon entity exists
        selectedAt = 0,
        entities = {}, -- [id] = true
        bones = {}, -- [name] = index
        nextHandle = 100,
        alive = {}, -- [handle] = true while a looped particle exists
        commands = {},
        exports = {},
        netEvents = {},
        handlers = {},
        otherPlayers = {}, -- [serverId] = { ped = id, coords = vec }
    }
end

local function record(fn, ...)
    calls[#calls + 1] = { fn = fn, args = { ... } }
end

local function count(fn, pred)
    local n = 0
    for _, c in ipairs(calls) do
        if c.fn == fn and (pred == nil or pred(c)) then n = n + 1 end
    end
    return n
end

local function fail(msg) error({ harness = msg }, 0) end
local function expect(cond, msg) if not cond then fail(msg) end end
local function expectEq(actual, expected, what)
    if actual ~= expected then fail(('%s: expected %s, got %s'):format(what, tostring(expected), tostring(actual))) end
end

----------------------------------------------------------------------------------------------
-- scheduler
----------------------------------------------------------------------------------------------
local function spawn(fn)
    local co = coroutine.create(fn)
    W.threads[#W.threads + 1] = { co = co, wake = W.now }
end

local function step(ms)
    W.now = W.now + ms
    for i = #W.threads, 1, -1 do
        local t = W.threads[i]
        if coroutine.status(t.co) == 'dead' then
            table.remove(W.threads, i)
        end
    end
    for _, t in ipairs(W.threads) do
        if coroutine.status(t.co) == 'suspended' and t.wake <= W.now then
            local ok, err = coroutine.resume(t.co)
            if not ok then fail('script error: ' .. tostring(err)) end
        end
    end
end

local function advance(totalMs, frame)
    frame = frame or 16
    local elapsed = 0
    while elapsed < totalMs do
        step(frame)
        elapsed = elapsed + frame
    end
end

----------------------------------------------------------------------------------------------
-- FiveM API mock (installed into _G)
----------------------------------------------------------------------------------------------
local function installApi(opts)
    opts = opts or {}
    _G.vector3 = vec
    _G.GetCurrentResourceName = function() return RES end
    _G.GetGameTimer = function() return W.now end
    _G.CreateThread = function(fn) spawn(fn) end
    _G.Citizen = { CreateThread = _G.CreateThread, Wait = nil }
    _G.Wait = function(ms)
        local t
        for _, th in ipairs(W.threads) do
            if th.co == coroutine.running() then t = th break end
        end
        if not t then fail('Wait() called outside of a script thread') end
        t.wake = W.now + math.max(ms, 1)
        coroutine.yield()
    end
    _G.GetHashKey = function(s) return joaat(s) end
    _G.print = function(...)
        local parts = {}
        for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
        logs[#logs + 1] = table.concat(parts, ' ')
    end
    _G.exports = function(name, fn) W.exports[name] = fn end
    _G.RegisterCommand = function(name, fn, restricted) W.commands[name] = { fn = fn, restricted = restricted } end
    _G.RegisterNetEvent = function(name, fn) W.netEvents[name] = fn end
    _G.AddEventHandler = function(name, fn)
        W.handlers[name] = W.handlers[name] or {}
        table.insert(W.handlers[name], fn)
    end
    _G.TriggerServerEvent = function(name, ...) record('TriggerServerEvent', name, ...) end
    _G.TriggerClientEvent = function(name, target, ...) record('TriggerClientEvent', name, target, ...) end

    _G.PlayerPedId = function() return 1 end
    _G.PlayerId = function() return 0 end
    _G.GetSelectedPedWeapon = function() record('GetSelectedPedWeapon') return W.ped.weapon end
    _G.IsPedShooting = function() return W.ped.shooting end
    _G.IsPedReloading = function() return W.ped.reloading end
    _G.IsEntityDead = function() return W.ped.dead end
    _G.GetEntityCoords = function(e)
        if e == 1 then return W.ped.coords end
        for _, p in pairs(W.otherPlayers) do if p.ped == e then return p.coords end end
        return vec(0, 0, 0)
    end
    _G.DoesEntityExist = function(e)
        if e == 1 or W.entities[e] == true then return true end
        for _, p in pairs(W.otherPlayers) do if p.ped == e then return true end end
        return false
    end
    _G.GetCurrentPedWeaponEntityIndex = function(ped)
        if ped == 1 then
            if W.weaponEntity ~= 0 and W.now - W.selectedAt >= W.weaponEntityDelay then return W.weaponEntity end
            return 0
        end
        for _, p in pairs(W.otherPlayers) do if p.ped == ped then return p.weapon or 0 end end
        return 0
    end
    _G.GetPlayerFromServerId = function(id) return W.otherPlayers[id] and id or -1 end
    _G.GetPlayerPed = function(player)
        if player == 1 then return 1 end -- the local/shooter ped
        if W.otherPlayers[player] then return W.otherPlayers[player].ped end
        return 0
    end
    _G.GetPlayers = function()
        local list = {}
        for id in pairs(W.otherPlayers) do list[#list + 1] = tostring(id) end
        list[#list + 1] = '1'
        table.sort(list)
        return list
    end

    _G.RequestNamedPtfxAsset = function(name) record('RequestNamedPtfxAsset', name) W.assetRequestedAt = W.now end
    _G.HasNamedPtfxAssetLoaded = function()
        return W.assetRequestedAt ~= nil and (W.now - W.assetRequestedAt) >= W.assetLoadDelay
    end
    _G.RemoveNamedPtfxAsset = function(name) record('RemoveNamedPtfxAsset', name) end
    if not opts.noUseAsset then
        _G.UseParticleFxAsset = function(name) W.pendingAsset = name record('UseParticleFxAsset', name) end
    elseif opts.legacyUseAsset then
        _G.UseParticleFxAssetNextCall = function(name) W.pendingAsset = name record('UseParticleFxAssetNextCall', name) end
    end

    local function started(fn, looped)
        return function(effect, entity, ...)
            if W.pendingAsset == nil then fail(fn .. ' called without a preceding UseParticleFxAsset') end
            W.pendingAsset = nil
            record(fn, effect, entity, ...)
            if looped then
                W.nextHandle = W.nextHandle + 1
                W.alive[W.nextHandle] = true
                return W.nextHandle
            end
            return true
        end
    end
    _G.StartParticleFxNonLoopedOnEntity = started('StartParticleFxNonLoopedOnEntity', false)
    _G.StartParticleFxNonLoopedAtCoord = started('StartParticleFxNonLoopedAtCoord', false)
    _G.StartParticleFxLoopedOnEntity = started('StartParticleFxLoopedOnEntity', true)
    if not opts.noBoneNatives then
        _G.StartParticleFxLoopedOnEntityBone = started('StartParticleFxLoopedOnEntityBone', true)
        _G.GetWorldPositionOfEntityBone = function(entity, bone) record('GetWorldPositionOfEntityBone', entity, bone) return vec(10, 20, 30) end
    end
    _G.GetEntityBoneIndexByName = function(entity, name) return W.bones[name] or -1 end
    _G.DoesParticleFxLoopedExist = function(h) return W.alive[h] == true end
    _G.StopParticleFxLooped = function(h, p) record('StopParticleFxLooped', h) end
    _G.RemoveParticleFx = function(h, p) record('RemoveParticleFx', h) W.alive[h] = nil end
    _G.SetParticleFxLoopedColour = function(h, r, g, b) record('SetParticleFxLoopedColour', h, r, g, b) end
end

local function resetApi()
    for _, name in ipairs({
        'vector3', 'GetCurrentResourceName', 'GetGameTimer', 'CreateThread', 'Citizen', 'Wait', 'GetHashKey', 'print', 'exports',
        'RegisterCommand', 'RegisterNetEvent', 'AddEventHandler', 'TriggerServerEvent', 'TriggerClientEvent', 'PlayerPedId',
        'PlayerId', 'GetSelectedPedWeapon', 'IsPedShooting', 'IsPedReloading', 'IsEntityDead', 'GetEntityCoords', 'DoesEntityExist',
        'GetCurrentPedWeaponEntityIndex', 'GetPlayerFromServerId', 'GetPlayerPed', 'GetPlayers', 'RequestNamedPtfxAsset',
        'HasNamedPtfxAssetLoaded', 'RemoveNamedPtfxAsset', 'UseParticleFxAsset', 'UseParticleFxAssetNextCall',
        'StartParticleFxNonLoopedOnEntity', 'StartParticleFxNonLoopedAtCoord', 'StartParticleFxLoopedOnEntity',
        'StartParticleFxLoopedOnEntityBone', 'GetWorldPositionOfEntityBone', 'GetEntityBoneIndexByName', 'DoesParticleFxLoopedExist',
        'StopParticleFxLooped', 'RemoveParticleFx', 'SetParticleFxLoopedColour', 'Config', 'source',
    }) do _G[name] = nil end
end

----------------------------------------------------------------------------------------------
-- helpers shared by scenarios
----------------------------------------------------------------------------------------------
local PISTOL = joaat('WEAPON_PISTOL')
local RIFLE = joaat('WEAPON_CARBINERIFLE')
local UNARMED = joaat('WEAPON_UNARMED')

local function boot(opts)
    opts = opts or {}
    W = newWorld()
    calls, logs = {}, {}
    resetApi()
    installApi(opts.api)
    local cfg = assert(loadfile(dir .. '/config.lua'))
    cfg()
    if opts.config then opts.config(_G.Config) end
    if opts.server then
        assert(loadfile(dir .. '/server.lua'))()
    else
        assert(loadfile(dir .. '/client.lua'))()
    end
end

local function equip(weapon, entityId)
    W.ped.weapon = weapon
    W.selectedAt = W.now
    if entityId then
        W.weaponEntity = entityId
        W.entities[entityId] = true
    else
        W.weaponEntity = 0
    end
end

local function shootOnce()
    W.ped.shooting = true
    step(16)
    W.ped.shooting = false
    step(16)
end

local function fxCalls(name) local out = {} for _, c in ipairs(calls) do if c.fn == name then out[#out + 1] = c end end return out end

----------------------------------------------------------------------------------------------
-- scenarios
----------------------------------------------------------------------------------------------
local S = {}

S['loads-cleanly-and-defaults-are-sane'] = function()
    boot()
    local c = _G.Config
    expect(type(c.Asset) == 'string' and #c.Asset > 0, 'Config.Asset missing')
    expect(#c.Effects >= 1, 'no effects configured')
    for i, fx in ipairs(c.Effects) do
        expect(type(fx.effect) == 'string', ('effect #%d has no name'):format(i))
        expect(type(fx.offset.x) == 'number' and type(fx.rotation.z) == 'number', ('effect #%d offset/rotation'):format(i))
        expect(#fx.triggers >= 1, ('effect #%d has no triggers'):format(i))
    end
    expect(W.commands[c.TestCommand] ~= nil, 'test command not registered')
    expect(W.exports.PlayEffect and W.exports.StopEffects, 'exports missing')
end

S['no-per-frame-polling-while-unarmed'] = function()
    boot()
    advance(3000) -- 3 s, ped unarmed
    local polls = count('GetSelectedPedWeapon')
    -- idle poll is 300 ms => about 10 checks in 3 s. A per-frame loop would make ~190.
    expect(polls <= 14, ('polled the weapon %d times in 3 s while unarmed (expected <= 14)'):format(polls))
    expectEq(count('RequestNamedPtfxAsset'), 0, 'asset must not be requested while unarmed')
    expectEq(count('IsPedShooting'), 0, 'fast loop must not run while unarmed')
end

S['loads-asset-once-and-plays-on-fire'] = function()
    boot()
    equip(PISTOL, 500)
    advance(800)
    expectEq(count('RequestNamedPtfxAsset'), 1, 'asset requests')
    shootOnce()
    local s = fxCalls('StartParticleFxNonLoopedOnEntity')
    expectEq(#s, 1, 'one-shot starts after one shot')
    local a = s[1].args
    expectEq(a[1], _G.Config.Effects[1].effect, 'effect name')
    expectEq(a[2], 500, 'attached to the weapon entity')
    expectEq(a[3], _G.Config.Effects[1].offset.x, 'offset.x')
    expectEq(a[9], _G.Config.Effects[1].scale, 'scale')
    shootOnce()
    expectEq(count('RequestNamedPtfxAsset'), 1, 'asset must be requested only once')
    expectEq(count('UseParticleFxAsset'), count('StartParticleFxNonLoopedOnEntity'), 'UseParticleFxAsset before each start')
end

S['automatic-fire-is-throttled'] = function()
    boot()
    equip(PISTOL, 500)
    advance(600)
    W.ped.shooting = true
    advance(1000) -- continuous fire for one second
    W.ped.shooting = false
    local n = count('StartParticleFxNonLoopedOnEntity')
    local gap = _G.Config.Effects[1].minIntervalMs
    expect(n >= 8, ('too few starts: %d'):format(n))
    expect(n <= (1000 // gap) + 2, ('flooded the particle system: %d starts in 1 s with a %d ms gap'):format(n, gap))
end

S['ignores-weapons-that-are-not-configured'] = function()
    boot({ config = function(c) c.Weapons = { 'WEAPON_PISTOL' } end })
    equip(RIFLE, 500)
    advance(1000)
    shootOnce()
    expectEq(count('RequestNamedPtfxAsset'), 0, 'asset must not load for an untracked weapon')
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 0, 'no effects for an untracked weapon')
end

S['empty-weapon-list-means-all-weapons'] = function()
    boot({ config = function(c) c.Weapons = {} end })
    equip(RIFLE, 500)
    advance(800)
    shootOnce()
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'effect for any weapon')
end

S['looped-idle-effect-starts-once-and-stops-on-switch'] = function()
    boot({ config = function(c)
        c.Weapons = { 'WEAPON_PISTOL' }
        c.Effects = { { effect = 'aura', triggers = { 'idle' }, loop = true, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 } }
    end })
    equip(PISTOL, 500)
    advance(5000)
    expectEq(count('StartParticleFxLoopedOnEntity'), 1, 'loop started exactly once over 5 s')
    expectEq(count('StopParticleFxLooped'), 0, 'not stopped while equipped')
    equip(UNARMED, nil)
    advance(600)
    expectEq(count('StopParticleFxLooped'), 1, 'stopped when the weapon is put away')
    expectEq(count('RemoveParticleFx'), 1, 'and removed')
    expect(next(W.alive) == nil, 'no particle left alive')
    equip(PISTOL, 501)
    advance(800)
    expectEq(count('StartParticleFxLoopedOnEntity'), 2, 'restarted after re-equip')
end

S['weapon-switch-cleans-up-before-restarting'] = function()
    boot({ config = function(c)
        c.Weapons = {}
        c.Effects = { { effect = 'aura', triggers = { 'idle' }, loop = true, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 } }
    end })
    equip(PISTOL, 500)
    advance(800)
    equip(RIFLE, 501)
    advance(800)
    local order = {}
    for _, c in ipairs(calls) do
        if c.fn == 'StartParticleFxLoopedOnEntity' or c.fn == 'StopParticleFxLooped' then order[#order + 1] = c.fn end
    end
    expectEq(table.concat(order, ','), 'StartParticleFxLoopedOnEntity,StopParticleFxLooped,StartParticleFxLoopedOnEntity', 'start/stop order')
    local alive = 0
    for _ in pairs(W.alive) do alive = alive + 1 end
    expectEq(alive, 1, 'exactly one live particle after switching')
end

S['dying-stops-loops'] = function()
    boot({ config = function(c)
        c.Effects = { { effect = 'aura', triggers = { 'idle' }, loop = true, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 } }
    end })
    equip(PISTOL, 500)
    advance(800)
    expectEq(count('StartParticleFxLoopedOnEntity'), 1, 'precondition')
    W.ped.dead = true
    advance(100)
    expect(next(W.alive) == nil, 'looped effect must stop when the player dies')
end

S['resource-stop-releases-everything'] = function()
    boot({ config = function(c)
        c.Effects = { { effect = 'aura', triggers = { 'idle' }, loop = true, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 } }
    end })
    equip(PISTOL, 500)
    advance(800)
    local stop = W.handlers['onResourceStop'][1]
    stop('some_other_resource')
    expect(next(W.alive) ~= nil, 'another resource stopping must not affect us')
    expectEq(count('RemoveNamedPtfxAsset'), 0, 'asset kept')
    stop(RES)
    expect(next(W.alive) == nil, 'our loops stop with the resource')
    expectEq(count('RemoveNamedPtfxAsset'), 1, 'asset released')
end

S['asset-load-failure-is-rate-limited-and-recovers'] = function()
    boot({ config = function(c) c.AssetTimeoutMs = 1000 c.AssetRetryMs = 5000 end })
    W.assetLoadDelay = math.huge -- the asset never arrives (yet)
    equip(PISTOL, 500)
    advance(1500)
    expectEq(count('RequestNamedPtfxAsset'), 1, 'one request for the first attempt')
    local function warnings()
        local n = 0
        for _, l in ipairs(logs) do if l:find('could not load particle asset', 1, true) then n = n + 1 end end
        return n
    end
    expectEq(warnings(), 1, 'exactly one actionable warning')
    local cmd = W.commands[_G.Config.TestCommand].fn
    cmd(0, {})
    advance(300)
    cmd(0, {})
    advance(300)
    shootOnce()
    expectEq(count('RequestNamedPtfxAsset'), 1, 'no new requests inside the retry cooldown (no hammering)')
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 0, 'nothing is started without the asset')
    -- after the cooldown a trigger retries (and fails again while the asset is still missing)
    advance(6000)
    cmd(0, {})
    advance(1500)
    expectEq(count('RequestNamedPtfxAsset'), 2, 'one retry after the cooldown')
    expectEq(warnings(), 2, 'the retry reports its own failure')
    -- the asset finally becomes available: the next trigger after the cooldown recovers
    W.assetLoadDelay = 100
    advance(6000)
    cmd(0, {})
    advance(600)
    expectEq(count('RequestNamedPtfxAsset'), 3, 'second retry')
    expect(#fxCalls('StartParticleFxNonLoopedOnEntity') >= 1, 'recovered: the effect plays once the asset is available')
end

S['waits-for-the-weapon-entity-to-stream-in'] = function()
    boot()
    W.weaponEntityDelay = 600
    equip(PISTOL, 500)
    advance(2000)
    shootOnce()
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'effect plays once the weapon entity exists')
    expectEq(fxCalls('StartParticleFxNonLoopedOnEntity')[1].args[2], 500, 'on the weapon entity')
end

S['test-command-plays-stops-and-falls-back-to-the-ped'] = function()
    boot({ config = function(c)
        c.Effects = {
            { effect = 'flash', triggers = { 'fired' }, loop = false, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'aura', triggers = { 'idle' }, loop = true, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
        }
    end })
    local cmd = W.commands[_G.Config.TestCommand].fn
    expectEq(W.commands[_G.Config.TestCommand].restricted, false, 'local-only preview command is unrestricted')
    cmd(0, {})
    advance(400)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'one-shot played')
    expectEq(fxCalls('StartParticleFxNonLoopedOnEntity')[1].args[2], 1, 'unarmed => attached to the ped')
    expectEq(#fxCalls('StartParticleFxLoopedOnEntity'), 1, 'loop started')
    cmd(0, {})
    advance(400)
    expectEq(#fxCalls('StartParticleFxLoopedOnEntity'), 1, 'running the command twice must not duplicate the loop')
    cmd(0, { 'stop' })
    advance(100)
    expect(next(W.alive) == nil, '"stop" ends looped effects')
    cmd(0, { '1' })
    advance(400)
    expectEq(#fxCalls('StartParticleFxLoopedOnEntity'), 1, 'effect number filter: only #1 (the one-shot) plays')
end

S['test-command-can-be-disabled'] = function()
    boot({ config = function(c) c.EnableTestCommand = false end })
    expect(W.commands[_G.Config.TestCommand] == nil, 'command must not exist when disabled')
end

S['exports-work-and-validate-input'] = function()
    boot()
    expectEq(W.exports.PlayEffect(999), false, 'unknown effect number is rejected')
    expectEq(W.exports.PlayEffect(1), true, 'valid effect accepted')
    advance(400)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'export played the effect')
    W.exports.StopEffects()
end

S['bones-use-entity-bone-natives-and-fall-back-gracefully'] = function()
    boot({ config = function(c)
        c.Effects = {
            { effect = 'looped_bone', triggers = { 'idle' }, loop = true, bone = 'gun_muzzle', offset = { x = 1, y = 2, z = 3 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'oneshot_bone', triggers = { 'fired' }, loop = false, bone = 'gun_muzzle', offset = { x = 1, y = 2, z = 3 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'missing_bone', triggers = { 'fired' }, loop = false, bone = 'no_such_bone', offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
        }
    end })
    W.bones['gun_muzzle'] = 7
    equip(PISTOL, 500)
    advance(800)
    expectEq(#fxCalls('StartParticleFxLoopedOnEntityBone'), 1, 'looped effect uses the bone native')
    expectEq(fxCalls('StartParticleFxLoopedOnEntityBone')[1].args[9], 7, 'bone index passed through')
    shootOnce()
    local atCoord = fxCalls('StartParticleFxNonLoopedAtCoord')
    expectEq(#atCoord, 1, 'one-shot with a bone is spawned at the bone world position')
    expectEq(atCoord[1].args[2], 11, 'bone position (10) + offset (1) on x (AtCoord takes x as its 2nd argument)')
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'unknown bone falls back to the entity origin')
    expectEq(fxCalls('StartParticleFxNonLoopedOnEntity')[1].args[1], 'missing_bone', 'the fallback effect')
end

S['reload-trigger-fires-on-the-rising-edge-only'] = function()
    boot({ config = function(c)
        c.Effects = { { effect = 'reload_fx', triggers = { 'reloaded' }, loop = false, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 } }
    end })
    equip(PISTOL, 500)
    advance(800)
    W.ped.reloading = true
    advance(1000) -- reloading for a whole second
    W.ped.reloading = false
    advance(100)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'exactly one effect per reload')
    W.ped.reloading = true
    advance(200)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 2, 'a second reload plays again')
end

S['equip-and-switch-triggers'] = function()
    boot({ config = function(c)
        c.Effects = {
            { effect = 'on_switch', triggers = { 'switched' }, loop = false, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'on_equip', triggers = { 'equipped' }, loop = false, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'manual_only', triggers = { 'manual' }, loop = false, offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
        }
    end })
    equip(PISTOL, 500)
    advance(800)
    local names = {}
    for _, c in ipairs(fxCalls('StartParticleFxNonLoopedOnEntity')) do names[#names + 1] = c.args[1] end
    table.sort(names)
    expectEq(table.concat(names, ','), 'on_equip,on_switch', 'switch+equip effects fire on selection; manual-only never fires automatically')
    shootOnce()
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 2, 'shooting does not trigger manual-only effects')
end

S['works-with-the-legacy-native-name'] = function()
    boot({ api = { noUseAsset = true, legacyUseAsset = true } })
    equip(PISTOL, 500)
    advance(800)
    shootOnce()
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'effect started')
    expectEq(count('UseParticleFxAssetNextCall'), 1, 'legacy UseParticleFxAssetNextCall used')
end

S['missing-optional-natives-do-not-crash'] = function()
    boot({ api = { noBoneNatives = true }, config = function(c)
        c.Effects = {
            { effect = 'looped_bone', triggers = { 'idle' }, loop = true, bone = 'gun_muzzle', offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
            { effect = 'oneshot_bone', triggers = { 'fired' }, loop = false, bone = 'gun_muzzle', offset = { x = 0, y = 0, z = 0 }, rotation = { x = 0, y = 0, z = 0 }, scale = 1.0 },
        }
    end })
    W.bones['gun_muzzle'] = 7
    equip(PISTOL, 500)
    advance(800)
    shootOnce()
    expectEq(#fxCalls('StartParticleFxLoopedOnEntity'), 1, 'plain looped native used instead')
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'plain one-shot native used instead')
end

S['sync-client-reports-own-effects'] = function()
    boot({ config = function(c) c.Sync.enabled = true end })
    equip(PISTOL, 500)
    advance(800)
    shootOnce()
    local sent = fxCalls('TriggerServerEvent')
    expectEq(#sent, 1, 'one report per played effect')
    expectEq(sent[1].args[1], RES .. ':sync', 'event name')
    expectEq(sent[1].args[2], 1, 'only a number is sent, never a string')
end

S['sync-client-renders-nearby-players-only'] = function()
    boot({ config = function(c) c.Sync.enabled = true c.Sync.radius = 50 end })
    local handler = W.netEvents[RES .. ':play']
    expect(handler ~= nil, 'play handler registered')
    W.entities[900] = true
    W.entities[901] = true
    W.otherPlayers[7] = { ped = 70, coords = vec(10, 0, 0), weapon = 900 }
    W.otherPlayers[8] = { ped = 80, coords = vec(500, 0, 0), weapon = 901 }
    handler(7, 1)
    advance(400)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'nearby player\'s effect rendered')
    expectEq(fxCalls('StartParticleFxNonLoopedOnEntity')[1].args[2], 900, 'on THEIR weapon entity')
    handler(8, 1)
    advance(400)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'far player ignored')
    handler(7, 99)
    handler(7, 'drop table')
    handler(7, 1.5)
    handler(99, 1) -- unknown player
    advance(400)
    expectEq(#fxCalls('StartParticleFxNonLoopedOnEntity'), 1, 'invalid payloads ignored')
end

S['server-validates-rate-limits-and-relays-to-nearby-players'] = function()
    boot({ server = true, config = function(c) c.Sync.enabled = true c.Sync.radius = 50 c.Sync.minIntervalMs = 100 end })
    W.ped.coords = vec(0, 0, 0)
    W.otherPlayers[2] = { ped = 20, coords = vec(10, 0, 0) }
    W.otherPlayers[3] = { ped = 30, coords = vec(5000, 0, 0) }
    -- the shooter is server id 1 whose ped is entity 1 at the origin
    local handler = W.netEvents[RES .. ':sync']
    expect(handler ~= nil, 'sync handler registered')
    local function send(src, ...)
        _G.source = src
        handler(...)
    end
    send(1, 1)
    local relays = fxCalls('TriggerClientEvent')
    expectEq(#relays, 1, 'relayed only to the nearby player')
    expectEq(relays[1].args[2], 2, 'target')
    expectEq(relays[1].args[3], 1, 'shooter id included')
    expectEq(relays[1].args[4], 1, 'effect index')
    send(1, 1) -- same instant: rate limited
    expectEq(#fxCalls('TriggerClientEvent'), 1, 'rate limited')
    for _, bad in ipairs({ 0, -1, 2, 1.5, 0 / 0, 'x', true }) do
        W.now = W.now + 1000
        send(1, bad)
    end
    expectEq(#fxCalls('TriggerClientEvent'), 1, 'invalid indices rejected (count unchanged)')
    W.now = W.now + 1000
    send(1, 1)
    expectEq(#fxCalls('TriggerClientEvent'), 2, 'valid again after the interval')
end

S['server-is-inert-when-sync-is-disabled'] = function()
    boot({ server = true, config = function(c) c.Sync.enabled = false end })
    _G.source = 1
    W.netEvents[RES .. ':sync'](1)
    expectEq(#fxCalls('TriggerClientEvent'), 0, 'nothing relayed')
end

----------------------------------------------------------------------------------------------
-- run
----------------------------------------------------------------------------------------------
local scenario = S[scenarioName]
if scenarioName == '--list' then
    local names = {}
    for k in pairs(S) do names[#names + 1] = k end
    table.sort(names)
    print(table.concat(names, '\n'))
    os.exit(0)
end
if not scenario then
    io.stdout:write('FAIL ' .. scenarioName .. ': unknown scenario\n')
    os.exit(2)
end

local realPrint = io.stdout
local ok, err = pcall(scenario)
if ok then
    realPrint:write('PASS ' .. scenarioName .. '\n')
    os.exit(0)
end
local msg = type(err) == 'table' and err.harness or tostring(err)
realPrint:write('FAIL ' .. scenarioName .. ': ' .. msg .. '\n')
if logs and #logs > 0 then
    realPrint:write('--- script output ---\n' .. table.concat(logs, '\n') .. '\n')
end
os.exit(1)
