-- VFXForge weapon effects: server relay (only loaded when Config.Sync.enabled = true)
--
-- Clients tell the server "I played effect N"; the server validates the request and forwards
-- it to nearby players so they can render the same effect on the shooter's weapon.
--
-- Security: the server never trusts the payload. The effect index must be a whole number
-- inside the configured range, each player is rate limited, and only a number is relayed —
-- never a client-supplied effect name or any other string.

local RESOURCE <const> = GetCurrentResourceName()
local lastSeen = {} -- [source] = GetGameTimer() of the last accepted request

local function warn(fmt, ...)
    print(('^3[%s] ' .. fmt .. '^7'):format(RESOURCE, ...))
end

local function isWholeNumber(n)
    return type(n) == 'number' and n == math.floor(n) and n == n
end

RegisterNetEvent(RESOURCE .. ':sync', function(index)
    local src = source
    if not Config.Sync or not Config.Sync.enabled then
        return
    end
    if not isWholeNumber(index) or index < 1 or index > #Config.Effects then
        if Config.Debug then
            warn('rejected sync from %s: invalid effect index %s', tostring(src), tostring(index))
        end
        return
    end
    local now = GetGameTimer()
    local minGap = Config.Sync.minIntervalMs or 60
    if lastSeen[src] and (now - lastSeen[src]) < minGap then
        return -- too fast: drop silently
    end
    lastSeen[src] = now

    -- With OneSync the server knows every player's position, so only nearby players are notified.
    local shooterPed = GetPlayerPed and GetPlayerPed(src) or 0
    local canFilter = shooterPed ~= 0 and GetEntityCoords ~= nil
    local origin = canFilter and GetEntityCoords(shooterPed) or nil
    local radius = (Config.Sync.radius or 60.0) * 1.5 -- generous: clients apply the exact check

    for _, player in ipairs(GetPlayers()) do
        local target = tonumber(player)
        if target ~= src then
            local send = true
            if origin ~= nil then
                local ped = GetPlayerPed(target)
                if ped ~= 0 then
                    send = #(GetEntityCoords(ped) - origin) <= radius
                end
            end
            if send then
                TriggerClientEvent(RESOURCE .. ':play', target, src, index)
            end
        end
    end
end)

AddEventHandler('playerDropped', function()
    lastSeen[source] = nil
end)
