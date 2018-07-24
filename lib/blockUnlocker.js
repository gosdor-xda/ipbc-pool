var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);

var logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

log('info', logSystem, 'Started');

var feeRecovery=0;

function runInterval(){
    async.waterfall([

        //update fee recovery
        function(callback){
            redisClient.hgetall(config.coin + ':stats', function(error, results){
                if (error){
                    log('error', logSystem, 'Error trying to get fee status from redis %j', [error]);
                    callback(true);
                    return;
                }
                if ((!results) ||(results == null) || (results.length === 0) ){
                    log('info', logSystem, 'No fees found');
                    callback(false);
                    return;
                }

				var paid = results.feesPaid ? parseInt(results.feesPaid) : 0;
				var recovered = results.feesRecovered ? parseInt(results.feesRecovered) : 0;
			

				feeRecovery = (paid+parseInt(config.payments.feeBuffer)) - recovered;
                log('info', logSystem, 'fee Recovery at:'+feeRecovery);

				if(feeRecovery < 0) feeRecovery = 0;

                callback(false);
            });
        },
        //Get all block candidates in redis
        function(callback){
            redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function(error, results){
                if (error){
                    log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                    callback(true);
                    return;
                }
                if (results.length === 0){
                    log('info', logSystem, 'No blocks candidates in redis');
                    callback(true);
                    return;
                }

                var blocks = [];

                for (var i = 0; i < results.length; i += 2){
                    var parts = results[i].split(':');
                    blocks.push({
                        serialized: results[i],
                        height: parseInt(results[i + 1]),
                        hash: parts[0],
                        time: parts[1],
                        difficulty: parts[2],
                        shares: parts[3]
                    });
                }

                callback(null, blocks);
            });
        },

        //Check if blocks are orphaned
        function(blocks, callback){
            async.filter(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblock', {height: block.height + config.blockUnlocker.heightfix}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.orphaned = blockHeader.hash === block.hash ? 0 : 1;
                    block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                    block.reward = blockHeader.reward;
                    block.reward2 = 0;
                    block.devfee = 0;
                    

					var blockJson = JSON.parse(result.json);
                    var minerTx = blockJson.miner_tx;

                    if (minerTx.vout.length != 3) {
                        log('error', logSystem, 'Coinbase transaction vout size is %d and not 2', [minerTx.vout.length]);
                    }
                    for (var i=0; i<minerTx.vout.length; i++) {
                      log('info', logSystem, 'Coinbase %d is %d', [i,minerTx.vout[i].amount]);
                      if (i==0) {
					  	 block.reward2 = minerTx.vout[i].amount
                      }
					  else
					  	block.devfee += minerTx.vout[i].amount;
                    }

                    mapCback(block.unlocked);
                });
            }, function(unlockedBlocks){

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
                    callback(true);
                    return;
                }

                callback(null, unlockedBlocks)
            })
        },

        //Get worker shares for each unlocked block
        function(blocks, callback){

            var redisCommands = blocks.map(function(block){
                return ['hgetall', config.coin + ':shares:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    var workerShares = replies[i];
                    blocks[i].workerShares = workerShares;
                }
                callback(null, blocks);
            });
        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];

            blocks.forEach(function(block){
                if (!block.orphaned) return;

                orphanCommands.push(['del', config.coin + ':shares:round' + block.height]);

                orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned
                ].join(':')]);

                if (block.workerShares) {
                    var workerShares = block.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        //orphanCommands.push(['hincrby', config.coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                    });
                }
            });

            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error, replies){
                    if (error){
                        log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var totalBlocksUnlocked = 0;
            blocks.forEach(function(block){
                if (block.orphaned) return;
                totalBlocksUnlocked++;

				unlockedBlocksCommands.push(['hincrby', config.coin + ':stats','feeBlocks',1]);
				unlockedBlocksCommands.push(['hincrby', config.coin + ':stats','feesRecovered',feeRecovery/blocks.length]);
                unlockedBlocksCommands.push(['del', config.coin + ':shares:round' + block.height]);
                unlockedBlocksCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                unlockedBlocksCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned,
                    block.reward2
                ].join(':')]);


				var total = 0;

                var feePercent = config.blockUnlocker.poolFee / 100;

                if (Object.keys(donations).length) {
                    for(var wallet in donations) {
                        var percent = donations[wallet] / 100;
                        feePercent += percent;
                        var workerReward = Math.round(block.reward2 * percent);
						total += workerReward;
                		unlockedBlocksCommands.push(['hincrby', config.coin + ':workers:' + wallet, 'balance', workerReward]);
                        log('info', logSystem, 'Block %d donation to %s as %d percent of reward: %d', [block.height, wallet, percent, workerReward]);
                    }
                }

				var totalFee = total;

                var reward = Math.round(block.reward2 - (block.reward2 * feePercent)) - Math.round(feeRecovery/blocks.length);

                log('info', logSystem, 'Unlocked %d block with reward %d and donation fee %d. Miners reward: %d. Fee Recovery: %d %d %d', [block.height, block.reward, feePercent, reward, feeRecovery/blocks.length,block.reward2,block.devfee]);

				var now = Date.now() / 1000 | 0;

                if (block.workerShares) {
                    var totalShares = parseInt(block.shares);
                    Object.keys(block.workerShares).forEach(function (worker) {
                        var percent = block.workerShares[worker] / totalShares;
                        var workerReward = Math.round(reward * percent);
						total += workerReward;
                        log('info', logSystem, 'added pending to %s for %d shares: %d', [worker, block.workerShares[worker], workerReward]);
                		unlockedBlocksCommands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', workerReward]);
                		unlockedBlocksCommands.push(['zadd', config.coin + ':blockstat:' + worker, block.height, [block.time,now,block.reward,block.workerShares[worker],totalShares,workerReward,Math.round(feeRecovery/blocks.length),totalFee,block.devfee,0,block.difficulty].join(':')]);
                    });
                }
                log('info', logSystem, 'total %d b', [total]);
            });

            if (unlockedBlocksCommands.length === 0){
                log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
                callback(true);
                return;
            }

            redisClient.multi(unlockedBlocksCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with unlocking blocks %j', [error]);
                    callback(true);
                    return;
                }
                log('info', logSystem, 'Unlocked %d blocks and update balances', [totalBlocksUnlocked]);
                callback(null);
            });
        }
    ], function(error, result){
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
    })
}

runInterval();
