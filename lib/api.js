var fs = require('fs');
var http = require('http');
var url = require("url");
var zlib = require('zlib');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var charts = require('./charts.js');
var authSid = Math.round(Math.random() * 10000000000) + '' + Math.round(Math.random() * 10000000000);

var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zremrangebyscore', config.coin + ':workerHashrate', '-inf', ''],
    ['zrange', config.coin + ':hashrate', 0, -1],
    ['zrange', config.coin + ':workerHashrate', 0, -1],
    ['hgetall', config.coin + ':stats'],
    ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
    ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats'],
    ['zcard', config.coin + ':blocks:matured'],
    ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
    ['zcard', config.coin + ':payments:all'],
    ['keys', config.coin + ':payments:*']
];

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};
var minersHashrate = {};
var workerHashrate = {};
var workerHashrateShares = {};
var workerHashrateBadShares = {};
var workerHashrateMIT = {};
var workerHashrateMAT = {};

var liveConnections = {};
var addressConnections = {};



function collectStats(){

    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;
    redisCommands[1][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){

                redisFinished = Date.now();

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[4],
                    blocks: replies[5].concat(replies[6]),
                    totalBlocks: parseInt(replies[9]) + (replies[5].length / 2),
                    payments: replies[10],
                    totalPayments: parseInt(replies[11]),
                    totalMinersPaid: replies[12].length - 1
                };

                var hashrates = replies[2];
                var workerHashrates = replies[3];

                minerStats = {};
                minersHashrate = {};
                workerHashrate = {};
                workerHashrateShares = {};
                workerHashrateBadShares = {};
                workerHashrateMIT = {};
                workerHashrateMAT = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minersHashrate[hashParts[1]] = (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }
                for (var i = 0; i < workerHashrates.length; i++){
                    var hashParts = workerHashrates[i].split(':');


					var type = hashParts[4]||0;
					if(!workerHashrate[hashParts[1]])workerHashrate[hashParts[1]]={};
					if(!workerHashrateMIT[hashParts[1]])workerHashrateMIT[hashParts[1]]={};
					if(!workerHashrateMAT[hashParts[1]])workerHashrateMAT[hashParts[1]]={};
					if(!workerHashrateShares[hashParts[1]])workerHashrateShares[hashParts[1]]={};
					if(!workerHashrateBadShares[hashParts[1]])workerHashrateBadShares[hashParts[1]]={};
					if((type==0)&&(i)) workerHashrate[hashParts[1]][hashParts[2]] = (workerHashrate[hashParts[1]][hashParts[2]] || 0) + parseInt(hashParts[0]);
					if((workerHashrateMIT[hashParts[1]][hashParts[2]]>hashParts[3])||(!workerHashrateMIT[hashParts[1]][hashParts[2]])) workerHashrateMIT[hashParts[1]][hashParts[2]]=hashParts[3];
					if((workerHashrateMAT[hashParts[1]][hashParts[2]]<hashParts[3])||(!workerHashrateMAT[hashParts[1]][hashParts[2]])) workerHashrateMAT[hashParts[1]][hashParts[2]]=hashParts[3];
					workerHashrateShares[hashParts[1]][hashParts[2]] = (workerHashrateShares[hashParts[1]][hashParts[2]] || 0) + 1;
					if(type!=0)workerHashrateBadShares[hashParts[1]][hashParts[2]] = (workerHashrateBadShares[hashParts[1]][hashParts[2]] || 0) + 1;
                }

                var totalShares = 0;

                for (var miner in minersHashrate){
                    var shares = minersHashrate[miner];
                    totalShares += shares;
                    minersHashrate[miner] = Math.round(shares / config.api.hashrateWindow);
                    minerStats[miner] = getReadableHashRateString(minersHashrate[miner]);
                }
                for (var miner in workerHashrate){
                    for (var worker in workerHashrate[miner]){
                        var shares = workerHashrate[miner][worker];

						var hrwindow = (workerHashrateMAT[miner][worker]-workerHashrateMIT[miner][worker])/1000;

						if(hrwindow==0)hrwindow=30;

						if(!workerHashrateBadShares[miner][worker]) workerHashrateBadShares[miner][worker]=0;
						if((!workerHashrateShares[miner][worker])||(workerHashrateShares[miner][worker]==0)) workerHashrateShares[miner][worker]=1;

						workerHashrate[miner][worker] = [
									getReadableHashRateString(Math.round(shares / hrwindow)),
									workerHashrateMAT[miner][worker]/1000,
									hrwindow/workerHashrateShares[miner][worker],
									(workerHashrateBadShares[miner][worker]/workerHashrateShares[miner][worker])*100
								];
                    }
                }

                data.miners = Object.keys(minerStats).length;

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);

                data.roundHashes = 0;

                if (replies[7]){
                    for (var miner in replies[7]){
                        if (config.poolServer.slushMining.enabled) {
                            data.roundHashes +=  parseInt(replies[7][miner]) / Math.pow(Math.E, ((data.lastBlockFound - dateNowSeconds) / config.poolServer.slushMining.weight)); //TODO: Abstract: If something different than lastBlockfound is used for scoreTime, this needs change. 
                        }
                        else {
                            data.roundHashes +=  parseInt(replies[7][miner]);
                        }
                    }
                }

                if (replies[8]) {
                    data.lastBlockFound = replies[8].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
				apiInterfaces.rpcDaemon('getblock', {height:reply.block_header.height}, function(error, reply){
					daemonFinished = Date.now();
					if (error){
						log('error', logSystem, 'Error getting daemon data %j', [error]);
						callback(true);
						return;
					}
					var blockHeader = reply.block_header;
					
					var blockJson = JSON.parse(reply.json);
					var minerTx = blockJson.miner_tx;

					var reward = 0;
					var coinbase = 0;

					if (minerTx.vout.length != 3) {
						log('error', logSystem, 'Coinbase transaction vout size is %d and not 2 '+JSON.stringify(minerTx), [minerTx.vout.length]);
					}
					for (var i=0; i<minerTx.vout.length; i++) {
						if (i == 0) {
							reward = minerTx.vout[i].amount
						}
						else
							coinbase += minerTx.vout[i].amount;
					}
					callback(null, {
						difficulty: blockHeader.difficulty,
						height: blockHeader.height,
						timestamp: blockHeader.timestamp,
						reward: reward,
						coinbase: coinbase,
						hash:  blockHeader.hash
					});
				});
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                hashrateWindow: config.api.hashrateWindow,
                fee: 0,
                coin: config.coin,
                coinUnits: config.coinUnits,
                coinDifficultyTarget: config.coinDifficultyTarget,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                donation: donations,
                version: version,
                minPaymentThreshold: config.payments.minPayment2,
                minPaymentThreshold2: config.payments.minPayment,
                minPaymentThreshold3: config.payments.minPayment3,
                denominationUnit: config.payments.denomination,
                blockTime: config.coinDifficultyTarget,
                slushMiningEnabled: config.poolServer.slushMining.enabled,
                weight: config.poolServer.slushMining.weight
            });
        },
        charts: charts.getPoolChartsData
    }, function(error, results){

        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }

    var redisCommands = [];
    redisCommands.push(['zrevrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES']);
    for (var address in addressConnections){
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
        redisCommands.push(['zrevrange', config.coin + ':blockstat:' + address, 0, config.api.workerblocks - 1, 'WITHSCORES']);
    }

    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);
		var candidates = replies[0];

        for (var i = 0; i < addresses.length; i++){
            var offset = (i * 3)+1;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats){
                res.end(JSON.stringify({error: "not found"}));
                return;
            }
				stats.hashrate = minerStats[address];
				res.end(JSON.stringify({stats: stats,payments: replies[offset + 1],blocks: replies[offset + 2]}));
        }
    });
}

function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    if (urlParts.query.longpoll === 'true'){
        redisClient.exists(config.coin + ':workers:' + address, function(error, result){
            if (!result){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            addressConnections[address] = response;
            response.on('finish', function(){
                delete addressConnections[address];
            })
        });
    }
    else{
        redisClient.multi([
            ['hgetall', config.coin + ':workers:' + address],
            ['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES'],
            ['zrevrange', config.coin + ':blockstat:' + address, 0, config.api.workerblocks - 1, 'WITHSCORES'],
            ['zrevrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES']
        ]).exec(function(error, replies){
            if (error || !replies[0]){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            
			var roundCommands = [];
			var candidates = replies[3];

        	for (var i = 0; i < candidates.length; i += 2){
				var height = candidates[i+1];
				roundCommands.push(['hget', config.coin + ':shares:round' + height,address]);
			};
    
			redisClient.multi(roundCommands).exec(function(err, replies2){
       			if (err)
				{
            		log('error', logSystem, 'RedisError %j \n %j', [err, roundCommands]);
                	response.end(JSON.stringify({error: 'error'}));
            		return;
        		}
            
				var parsedCandidates = [];
        		for (var i = 0; i < candidates.length; i += 2){
					var height = candidates[i+1];
					var parts = candidates[i].split(':');
				
					if(replies2[i/2]){
						parsedCandidates.push(parts[1]+':'+parts[3]+':'+replies2[i/2]);
						parsedCandidates.push(height);
					}
            	};
            
				var stats = replies[0];
				stats.hashrate = minerStats[address];
				charts.getUserChartsData(address, replies[1], function(error, chartsData) {
					response.end(JSON.stringify({
						stats: stats,
						payments: replies[1],
						blocks: replies[2],
						candidates: parsedCandidates,
						workers: workerHashrate[address],
						charts: chartsData
					}));
				});

			});


        });
    }
}


function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
        paymentKey = ':payments:' + urlParts.query.address;

    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    )
}

function handleGetUserBlocks(urlParts, response){

    if (!urlParts.query.address)
        reply = JSON.stringify({error: 'query failed'});


    redisClient.zrevrangebyscore(
            config.coin + ':blockstat:' + urlParts.query.address,
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.workerblocks,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    )
}

function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}

function handleGetMinersHashrate(response) {
    var reply = JSON.stringify({
        minersHashrate: minersHashrate
    });
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

function parseCookies(request) {
    var list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        list[parts.shift().trim()] = unescape(parts.join('='));
    });
    return list;
}

function authorize(request, response){
    if(request.connection.remoteAddress == '127.0.0.1') {
        return true;
    }

    response.setHeader('Access-Control-Allow-Origin', '*');

    var cookies = parseCookies(request);
    if(cookies.sid && cookies.sid == authSid) {
        return true;
    }

    var sentPass = url.parse(request.url, true).query.password;


    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    log('warn', logSystem, 'Admin authorized');
    response.statusCode = 200;

    var cookieExpire = new Date( new Date().getTime() + 60*60*24*1000);
    response.setHeader('Set-Cookie', 'sid=' + authSid + '; path=/; expires=' + cookieExpire.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');


    return true;
}

function handleAdminStats(response){

    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}


function handleAdminUsers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'balance', 'paid', 'lastShare', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var workersData = {};
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var data = redisData[i];
                    workersData[address] = {
                        pending: data[0],
                        paid: data[1],
                        lastShare: data[2],
                        hashes: data[3],
                        hashrate: minersHashrate[address] ? minersHashrate[address] : 0
                    };
                }
                callback(null, workersData);
            });
        }
    ], function(error, workersData) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            response.end(JSON.stringify(workersData));
        }
    );
}


function handleAdminMonitoring(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}

function handleAdminLog(urlParts, response){
    var file = urlParts.query.file;
    var filePath = config.logging.files.directory + '/' + file;
    if(!file.match(/^\w+\.log$/)) {
        response.end('wrong log file');
    }
    response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response)
}


function startRpcMonitoring(rpc, module, method, interval) {
    setInterval(function() {
        rpc(method, {}, function(error, response) {
            var stat = {
                lastCheck: new Date() / 1000 | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response)
            };
            if(error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }
            var key = getMonitoringDataKey(module);
            var redisCommands = [];
            for(var property in stat) {
                redisCommands.push(['hset', key, property, stat[property]]);
            }
            redisClient.multi(redisCommands).exec();
        });
    }, interval * 1000);
}

function getMonitoringDataKey(module) {
    return config.coin + ':status:' + module;
}

function initMonitoring() {
    var modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet
    };
    for(var module in config.monitoring) {
        var settings = config.monitoring[module];
        if(settings.checkInterval) {
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval);
        }
    }
}



function getMonitoringData(callback) {
    var modules = Object.keys(config.monitoring);
    var redisCommands = [];
    for(var i in modules) {
        redisCommands.push(['hgetall', getMonitoringDataKey(modules[i])])
    }
    redisClient.multi(redisCommands).exec(function(error, results) {
        var stats = {};
        for(var i in modules) {
            if(results[i]) {
                stats[modules[i]] = results[i];
            }
        }
        callback(error, stats);
    });
}

function getLogFiles(callback) {
    var dir = config.logging.files.directory;
    fs.readdir(dir, function(error, files) {
        var logs = {};
        for(var i in files) {
            var file = files[i];
            var stats = fs.statSync(dir + '/' + file);
            logs[file] = {
                size: stats.size,
                changed: Date.parse(stats.mtime) / 1000 | 0
            }
        }
        callback(error, logs);
    });
}

var server = http.createServer(function(request, response){

    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/stats':
            var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
            var reply = deflate ? currentStatsCompressed : currentStats;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': deflate ? 'deflate' : '',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("finish", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;
        case '/get_userblocks':
            handleGetUserBlocks(urlParts, response);
            break;
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;
        case '/admin_stats':
            if (!authorize(request, response))
                return;
            handleAdminStats(response);
            break;
        case '/admin_monitoring':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminMonitoring(response);
            break;
        case '/admin_log':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminLog(urlParts, response);
            break;
        case '/admin_users':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminUsers(response);
            break;

        case '/miners_hashrate':
            
			if ((response.socket.remoteAddress !== '::ffff:127.0.0.1') && !authorize(request, response))
                return;
            handleGetMinersHashrate(response);
            break;

        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }
});

collectStats();
initMonitoring();

server.listen(config.api.port, function(){
    log('info', logSystem, 'API started & listening on port %d', [config.api.port]);
});

setTimeout(function(){

	log('info', logSystem, 'restart');
	process.exit(0);

}, 60 * 60 * 1000);

