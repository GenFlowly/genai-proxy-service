export const onboardCustomer = async () => {
    console.log('!!! MANUAL MOCK onboardCustomer called !!!');
    return {
        customerId: 'mock-customer-id',
        customerName: 'Neel',
        customerPicture: 'https://avatars.githubusercontent.com/u/7536192?v=4',
        aiVendorAPIKeyStatusList: [],
        aiConfigPreferences: null,
        customerInstructions: []
    };
};
