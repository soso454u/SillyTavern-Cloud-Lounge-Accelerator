export async function repairAccelerator({ cacheController, restartModules }) {
    await restartModules({ stopOnly: true });
    const cacheResult = await cacheController.repair();
    await restartModules({ skipCache: true });
    return cacheResult;
}
