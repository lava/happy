// Machine List Debug Script
// Run this in the browser console to debug machine visibility issues

// Get the Zustand storage state directly
const storage = window.__ZUSTAND_STORAGE__ ||
                window.storage ||
                Object.values(window).find(v => v?.getState?.()?.machines);

if (!storage) {
    console.log("❌ Could not find storage. Try: Object.keys(window).filter(k => k.includes('storage') || k.includes('zustand'))");
} else {
    const state = storage.getState();

    console.log("🔍 Machine Debug Info");
    console.log("===================");

    // Show data ready status
    console.log("📊 Data ready:", state.isDataReady);

    // Show all machines (including inactive)
    const allMachines = Object.values(state.machines || {});
    console.log(`📱 Total machines in storage: ${allMachines.length}`);

    // Show active vs inactive breakdown
    const activeMachines = allMachines.filter(m => m.active);
    const inactiveMachines = allMachines.filter(m => !m.active);

    console.log(`✅ Active machines: ${activeMachines.length}`);
    console.log(`❌ Inactive machines: ${inactiveMachines.length}`);

    // Detailed machine info
    console.log("\n📋 All Machines Details:");
    allMachines.forEach((machine, i) => {
        const displayName = machine.metadata?.displayName || machine.metadata?.host || machine.id;
        console.log(`${i + 1}. ${displayName}`);
        console.log(`   ID: ${machine.id}`);
        console.log(`   Host: ${machine.metadata?.host || 'unknown'}`);
        console.log(`   Active: ${machine.active}`);
        console.log(`   Created: ${new Date(machine.createdAt).toLocaleString()}`);
        console.log(`   Updated: ${new Date(machine.updatedAt).toLocaleString()}`);
        console.log("");
    });

    // Show what useAllMachines would return
    const visibleMachines = activeMachines.sort((a, b) => b.createdAt - a.createdAt);
    console.log("👁️ Machines visible in picker:");
    visibleMachines.forEach((machine, i) => {
        const displayName = machine.metadata?.displayName || machine.metadata?.host || machine.id;
        console.log(`${i + 1}. ${displayName} (${machine.active ? 'online' : 'offline'})`);
    });

    if (inactiveMachines.length > 0) {
        console.log("\n🚫 Hidden (inactive) machines:");
        inactiveMachines.forEach((machine, i) => {
            const displayName = machine.metadata?.displayName || machine.metadata?.host || machine.id;
            console.log(`${i + 1}. ${displayName} - Last seen: ${new Date(machine.updatedAt).toLocaleString()}`);
        });
    }
}

// Alternative: Find React DevTools or component state
const findReactFiber = (element) => {
    for (let key in element) {
        if (key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$')) {
            return element[key];
        }
    }
    return null;
};

// Look for machine data in React components
const body = document.body;
const fiber = findReactFiber(body);
if (fiber) {
    console.log("🔍 Found React fiber, searching for machine data...");
    // This will help you explore the React component tree
    console.log("Fiber:", fiber);
}

// Also try to find any global variables
console.log("🌐 Global variables containing 'machine':");
Object.keys(window).filter(key =>
    key.toLowerCase().includes('machine') ||
    key.toLowerCase().includes('storage') ||
    key.toLowerCase().includes('zustand')
).forEach(key => {
    console.log(`${key}:`, window[key]);
});

/*
What to look for:

1. Missing machine: Check if your expected machine appears in "All Machines Details"
   but with `Active: false`
2. Timing issue: Compare `updatedAt` timestamps to see when machines were last seen
3. ID mismatch: Verify the machine ID matches what you expect
4. Metadata issues: Check if `displayName` or `host` metadata is missing

If you find your machine but it's inactive, that's why it's not showing in the picker.
The machine needs `active: true` to be selectable.
*/