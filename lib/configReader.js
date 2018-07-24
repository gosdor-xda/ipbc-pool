var fs = require('fs');

var configFile = (function(){
    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-config=') === 0)
            return process.argv[i].split('=')[1];
    }
    return 'config.json';
})();


try {
    global.config = JSON.parse(fs.readFileSync(configFile));
}
catch(e){
    console.error('Failed to read config file ' + configFile + '\n\n' + e);
    return;
}

var donationAddresses = {
    devDonation: {
        TUBE: 'bxcLbGsee1gFmeLgfxPcWzfmhBfGd8yJZFvH59hWNimiQoURYCSpE9oKUTTi31mQ1fVDYvUMwabQX7CCtTER35Gz2iHRGUnjQ'
    },
    coreDevDonation: {
        TUBE: 'bxcLbGsee1gFmeLgfxPcWzfmhBfGd8yJZFvH59hWNimiQoURYCSpE9oKUTTi31mQ1fVDYvUMwabQX7CCtTER35Gz2iHRGUnjQ'
    },
    extraFeaturesDevDonation: {
        TUBE: 'bxcLbGsee1gFmeLgfxPcWzfmhBfGd8yJZFvH59hWNimiQoURYCSpE9oKUTTi31mQ1fVDYvUMwabQX7CCtTER35Gz2iHRGUnjQ'
    }
};

global.donations = {};

for(var configOption in donationAddresses) {
    var percent = config.blockUnlocker[configOption];
    var wallet = donationAddresses[configOption][config.symbol];
    if(percent && wallet) {
        global.donations[wallet] = percent;
    }
}

global.version = "v1.1.4";
