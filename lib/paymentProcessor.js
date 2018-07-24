var fs = require('fs');
var cnUtil = require('cryptonote-util');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);


var logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

var sumoWalletBase58AddressPrefix = 0xd1;
var sumoWalletBase58SubAddressPrefix = 16463;


log('info', logSystem, 'Started');


function runInterval(){
	
    async.waterfall([

        //Get worker keys
        function(callback){
            redisClient.keys(config.coin + ':workers:*', function(error, result) {
                if (error) {
                    log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, result);
            });
        },

        //Get worker balances
        function(keys, callback){
            var redisCommands = keys.map(function(k){
                return ['hmget', k, 'balance','lastpayment'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                var balances = {};
                var ages = {};
                for (var i = 0; i < replies.length; i++){
                    var parts = keys[i].split(':');
                    var workerId = parts[parts.length - 1];
				   	

                    balances[workerId] = parseInt(replies[i][0]) || 0;
                    ages[workerId] = parseInt(replies[i][1]) || 0;
                }
                callback(null, balances,ages);
            });
        },

        //Filter workers under balance threshold for payment
        function(balances,ages, callback){
			
    		var dateNowSeconds = Date.now() / 1000 | 0;

            var payments = {};
            var payments_i = {};

            for (var worker in balances){
                var balance = balances[worker];

            	var addressPrefix = cnUtil.address_decode(new Buffer(worker));
            	if (addressPrefix != sumoWalletBase58AddressPrefix)
					continue;
                    
				if(ages[worker] > dateNowSeconds-60*60)
					continue;

				var min = config.payments.minPayment;

				if(ages[worker] < dateNowSeconds-60*60*24)
					min = config.payments.minPayment2;

				if (balance >= min)
                    payments[worker] = balance;
            }
            
			for (var worker in balances){
                var balance = balances[worker];

            	var addressPrefix = cnUtil.address_decode_integrated(new Buffer(worker));
            	if (addressPrefix != sumoWalletBase58SubAddressPrefix)
					continue;

				if(ages[worker] > dateNowSeconds-60*60*3)
					continue;

				var min = config.payments.minPayment3;

				if (balance >= min)
                    payments_i[worker] = balance;
            }


            if ((Object.keys(payments).length === 0)&&(Object.keys(payments_i).length === 0)){
                log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
                callback(true);
                return;
            }
            
			var transferCommands = [];
            var addresses = 0;
            var commandAmount = 0;
            var commandIndex = 0;
            
			for (var worker in payments_i){
                var amount = parseInt(payments_i[worker]);
				if(config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
		            amount = config.payments.maxTransactionAmount - commandAmount;
	            }
				
				if(!transferCommands[commandIndex]) {
					transferCommands[commandIndex] = {
						redis: [],
						amount : 0,
						rpc: {
							destinations: [],
							priority: config.payments.priority,
							mixin: config.payments.mixin,
							unlock_time: 0
						}
					};
				}
				
                transferCommands[commandIndex].rpc.destinations.push({amount:amount, address: worker});
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].redis.push(['hset', config.coin + ':workers:' + worker, 'lastpayment', dateNowSeconds]);
                transferCommands[commandIndex].amount += amount;

                commandIndex++;
            }
			
            for (var worker in payments){
                var amount = parseInt(payments[worker]);
				if(config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
		            amount = config.payments.maxTransactionAmount - commandAmount;
	            }
				
				if(!transferCommands[commandIndex]) {
					transferCommands[commandIndex] = {
						redis: [],
						amount : 0,
						rpc: {
							destinations: [],
							priority: config.payments.priority,
							mixin: config.payments.mixin,
							unlock_time: 0
						}
					};
				}
				
                transferCommands[commandIndex].rpc.destinations.push({amount:amount, address: worker});
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].redis.push(['hset', config.coin + ':workers:' + worker, 'lastpayment', dateNowSeconds]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
				commandAmount += amount;
                if (addresses >= config.payments.maxAddresses || ( config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount)) {
                    commandIndex++;
                    addresses = 0;
					commandAmount = 0;
                }
            }


            var timeOffset = 0;

            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces.rpcWallet('transfer_split', transferCmd.rpc, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                        log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
                        cback(false);
                        return;
                    }

                   log('error', logSystem, JSON.stringify(result));

                    
					for (var l = 0; l < result.amount_list.length; l++){
				
						var now = (timeOffset++) + Date.now() / 1000 | 0;
						//var txHash = result.tx_hash.replace('<', '').replace('>', '');
						
						transferCmd.redis.push(['HINCRBY', config.coin + ':stats', 'feesPaid', result.fee_list[l]]);

						transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
							result.tx_hash_list[l],
							result.amount_list[l],
							result.fee_list[l],
							transferCmd.rpc.mixin,
							Object.keys(transferCmd.rpc.destinations).length
						].join(':')]);


					}
					
					for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
						var destination = transferCmd.rpc.destinations[i];
						transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
							result.tx_hash_list[0],
							destination.amount,
							result.tx_hash_list[0],
							transferCmd.rpc.mixin
						].join(':')]);
					}

                    log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
                    redisClient.multi(transferCmd.redis).exec(function(error, replies){
                        if (error){
                            log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                            log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                            cback(false);
                            return;
                        }
                        cback(true);
                    });
                });
            }, function(succeeded){
                var failedAmount = transferCommands.length - succeeded.length;
                log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);
                callback(null);
            });

        }

    ], function(error, result){
        setTimeout(runInterval, config.payments.interval * 1000);
    });
}

runInterval();
