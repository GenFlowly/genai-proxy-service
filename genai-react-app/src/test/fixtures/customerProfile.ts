export const mockOnboardRequest = {
    sub: "github|7536192",
    email: "",
    name: "Neel",
    picture: "https://avatars.githubusercontent.com/u/7536192?v=4",
    client: "REACT_APP"
};

export const mockOnboardResponse = {
    customerId: "CU1C040186FF2F",
    aiConfigPreferences: {
        preferredModels: [
            { aiVendor: "CLAUDE", model: "claude-3-haiku-20240307" },
            { aiVendor: "OPENAI", model: "gpt-3.5-turbo" },
            { aiVendor: "GEMINI", model: "gemini-2.5-flash" }
        ],
        preferredGenerativeMode: "FACTUAL"
    },
    aiVendorAPIKeyStatusList: [
        { aiVendor: "OPENAI", isAPIKeyValid: true, status: "API key is valid", updateSuccessful: false },
        { aiVendor: "GEMINI", isAPIKeyValid: true, status: "API key is valid", updateSuccessful: false },
        { aiVendor: "CLAUDE", isAPIKeyValid: true, status: "API key is valid", updateSuccessful: false }
    ],
    customerName: "Neel",
    customerPicture: "https://avatars.githubusercontent.com/u/7536192?v=4",
    customerInstructions: [
        { id: "INS-1069c6f5-a20b-4de0-b294-a92dfef1e051", version: 12, name: "Pokemon", instruction: "You are a pokemon" },
        { id: "INS-9b2d0d5c-769c-46f5-91c1-b9c5e6299140", version: 9, name: "Piano Teacher", instruction: "You are an artist.\nYour expertise is in piano.\nYou also teach piano to young kids. " },
        { id: "INS-58eccb72-dcc7-42cb-9814-bffca7fd3267", version: 3, name: "Tax Attorney", instruction: "You are an tax expert in USA. You know how to reduce tax bills for induviduals \nand investors. \n\nDo not jump straight into answering the prompt. Ask more clarifying questions to \nunderstand user's unique situtation. \n\nDo not make assumptions. " },
        { id: "INS-29c30f9b-0edf-40cc-a51d-77a304e65b79", version: 1, name: "Python Developer", instruction: "You are a python developer" },
        { id: "INS-2cd44625-cbf6-434f-a7d5-24a3d0af19b8", version: 1, name: "Senior Software Engineer", instruction: "You are a senior software engineer" },
        { id: "INS-79875190-bce8-4c2c-9fd1-ee509187741e", version: 1, name: "Behavioral Scientist", instruction: "You are a pshycologist. You are an expert in human behavior and you know how train and change them scietifically" },
        { id: "INS-8092d447-81bb-42f2-9c5b-2f7248789c29", version: 1, name: "Technical Learning Specialist", instruction: "I want to learn Fine tuning prompts from scratch. Create a complete roadmap from beginner to advanced that you can follow with weekly milestones." },
        { id: "INS-9a3cf562-bbb7-41fa-9aa4-979d1f9f9a0b", version: 1, name: "User Flow Designer", instruction: "You are a product manager.\nYou design the user flow for consumer facing software apps. \nYour goal is to build easy to use flows for softwares. " },
        { id: "INS-a546aa87-3626-4b10-8a69-ef9f753294d6", version: 1, name: "Copyright Attorney", instruction: "You are a copyright expert with vast legal knowledge." }
    ]
};
