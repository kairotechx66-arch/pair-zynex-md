var commands = [];

function cmd(info, func) {
    var data = info;

    if (typeof func !== 'function') {
        console.warn(`⚠️ cmd() called without a valid function handler for pattern: ${data?.pattern || data?.cmdname || '(unknown)'}`);
    }
    data.function = func;

    // Si pas de pattern, on utilise cmdname
    if (!data.pattern && data.cmdname) data.pattern = data.cmdname;

    if (!data.pattern) {
        console.warn('⚠️ cmd() called without a pattern or cmdname — command was not registered.');
        return data;
    }

    if (!data.alias) data.alias = [];
    if (!data.dontAddCommandList) data.dontAddCommandList = false;
    if (!data.desc) data.desc = '';
    if (!data.fromMe) data.fromMe = false;
    if (!data.category) data.category = 'misc';

    // Vérifier les doublons de pattern
    const exists = commands.find(c => c.pattern === data.pattern);
    if (exists) {
        console.warn(`⚠️ Duplicate command pattern detected: "${data.pattern}" — overwriting previous registration.`);
        commands.splice(commands.indexOf(exists), 1);
    }

    commands.push(data);
    return data;
}

module.exports = {
    cmd,
    AddCommand: cmd,
    Function: cmd,
    commands,
};
